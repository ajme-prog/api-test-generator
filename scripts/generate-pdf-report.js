#!/usr/bin/env node
/**
 * generate-pdf-report.js  (v3)
 *
 * Produce un PDF con graficas reales (matplotlib) listo para la tesis:
 *   - Portada con metadata del run
 *   - Resumen ejecutivo (tabla de metricas)
 *   - Grafica 1: Evolucion tasa de exito entre iteraciones (linea)
 *   - Grafica 2: Casos generados vs ejecutados (barras agrupadas)
 *   - Grafica 3: Tiempo promedio de respuesta (linea)
 *   - Grafica 4: Tasa de deteccion de fallos (barras + tendencia)
 *   - Grafica 5: Distribucion assertions pass/fail (pie)
 *   - Grafica 6: Cobertura de endpoints (barras)
 *   - Detalle de fallos detectados
 *   - Seccion inyeccion de fallos
 */

require('dotenv').config();
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '../reports');
const OUTPUT_PDF  = path.join(REPORTS_DIR, 'metrics-report.pdf');
fs.mkdirSync(REPORTS_DIR, { recursive: true });

function load(file) {
  const p = path.join(REPORTS_DIR, file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const generation   = load('generation-metrics.json');
const newman       = load('newman-report.json');
const consolidated = load('consolidated-report.json');
const faults       = load('fault-injection-summary.json');
const historyPath  = path.join(REPORTS_DIR, 'runs-history.json');
const history      = fs.existsSync(historyPath)
  ? JSON.parse(fs.readFileSync(historyPath, 'utf8'))
  : null;

if (!generation && !newman) {
  console.error('No se encontraron metricas. Ejecuta el pipeline primero.');
  process.exit(1);
}

const stats   = newman?.run?.stats   || {};
const timings = newman?.run?.timings || {};
const execs   = newman?.run?.executions || [];

const totalAssert = stats.assertions?.total  || 0;
const failAssert  = stats.assertions?.failed || 0;
const passAssert  = totalAssert - failAssert;
const passRate    = totalAssert ? ((passAssert / totalAssert) * 100).toFixed(1) : '0';

const rts  = execs.map(e => e.response?.responseTime).filter(t => t != null);
const avgRT = rts.length ? Math.round(rts.reduce((a,b)=>a+b,0)/rts.length) : 0;
const maxRT = rts.length ? Math.max(...rts) : 0;
const totalMs = timings.completed ? Math.round((timings.completed - timings.started)/1000) : 0;

const failedTests = execs
  .filter(e => e.assertions?.some(a => a.error))
  .map(e => ({
    name:   e.item?.name || 'Sin nombre',
    status: e.response?.status || '?',
    errors: e.assertions.filter(a => a.error).map(a => a.error.message),
  }));

const runId     = process.env.GITHUB_RUN_NUMBER || 'local';
const commitSha = (process.env.GITHUB_SHA || 'local').substring(0,7);
const branch    = process.env.GITHUB_REF?.replace('refs/heads/','') || 'local';
const now       = new Date().toISOString();
const casesGen  = generation?.casesGenerated || 0;
const tokensUsed= generation?.tokensUsed?.total_tokens || 0;
const genDurSec = generation?.generationDurationSeconds || 0;
const apiEps    = generation?.apiEndpoints || 0;
const coveragePct = consolidated?.coverage?.coveragePercent
  ? parseFloat(consolidated.coverage.coveragePercent) : 0;

const pdata = {
  now, runId, commitSha, branch,
  casesGen, tokensUsed, genDurSec, apiEps,
  totalAssert, passAssert, failAssert,
  passRate: parseFloat(passRate),
  avgRT, maxRT, totalMs, coveragePct,
  totalReqs: stats.requests?.total || 0,
  failedTests: failedTests.slice(0,15),
  faults: faults || null,
  history: history ? history.slice(-10) : null,
  outputPdf: OUTPUT_PDF,
};

const dataPath = path.join(REPORTS_DIR, '_pdf_data.json');
fs.writeFileSync(dataPath, JSON.stringify(pdata, null, 2));

// ─── Python script ─────────────────────────────────────────────────────────
const py = `
import json, sys, io
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                 TableStyle, HRFlowable, PageBreak, Image as RLImage)

C = {'acc':'#4f46e5','acc2':'#7c3aed','ok':'#16a34a','warn':'#d97706',
     'err':'#dc2626','gray':'#6b7280','light':'#f0f0ff'}

def hx(h):
    h=h.lstrip('#'); r,g,b=int(h[:2],16)/255,int(h[2:4],16)/255,int(h[4:],16)/255
    return colors.Color(r,g,b)

plt.rcParams.update({
    'font.family':'DejaVu Sans','axes.spines.top':False,
    'axes.spines.right':False,'axes.grid':True,'grid.alpha':0.3,
    'grid.linestyle':'--','figure.facecolor':'white','axes.facecolor':'#f9f9ff',
})

def to_img(fig, w=6.4, h=3.1):
    buf=io.BytesIO()
    fig.savefig(buf,format='png',dpi=150,bbox_inches='tight',
                facecolor='white',edgecolor='none')
    buf.seek(0); plt.close(fig)
    return RLImage(buf,width=w*inch,height=h*inch)

def pct_val(s):
    try: return float(str(s).replace('%',''))
    except: return 0.0

with open(sys.argv[1]) as f: d=json.load(f)

H = d.get('history') or []
has_hist = len(H) > 1

# ── G1: tasa de exito ────────────────────────────────────────────────────
def g1():
    fig,ax=plt.subplots(figsize=(6.4,2.9))
    if has_hist:
        lbs=[str(r.get('runId','?')) for r in H]
        vs=[pct_val(r.get('passRate',0)) for r in H]
        ax.plot(lbs,vs,color=C['acc'],lw=2.5,marker='o',ms=6,
                mfc='white',mew=2,zorder=3)
        ax.fill_between(range(len(vs)),vs,alpha=0.13,color=C['acc'])
        ax.set_xticks(range(len(lbs)))
        ax.set_xticklabels(lbs,rotation=30,ha='right',fontsize=8)
        ax.axhline(80,color=C['ok'],ls=':',lw=1.2,label='Meta 80%')
        ax.legend(fontsize=8)
        ax.set_ylim(0,105)
    else:
        v=d['passRate']
        clr=C['ok'] if v>=80 else C['warn'] if v>=60 else C['err']
        ax.barh([''],[v],color=clr,height=0.5,zorder=3)
        ax.barh([''],[100-v],left=[v],color='#e5e7eb',height=0.5)
        ax.set_xlim(0,105)
        ax.text(v/2,0,f'{v}%',va='center',ha='center',
                color='white',fontweight='bold',fontsize=14)
    ax.set_ylabel('% exito',fontsize=9)
    ax.set_title('Figura 1. Evolucion de la tasa de exito de assertions',
                 fontsize=10,fontweight='bold',pad=8)
    fig.tight_layout(); return to_img(fig)

# ── G2: casos generados vs ejecutados ────────────────────────────────────
def g2():
    fig,ax=plt.subplots(figsize=(6.4,2.9))
    if has_hist:
        lbs=[str(r.get('runId','?')) for r in H]
        gv=[r.get('casesGenerated',0) for r in H]
        ev=[r.get('casesExecuted',0)  for r in H]
        x=np.arange(len(lbs)); w=0.38
        ax.bar(x-w/2,gv,w,label='Generados', color=C['acc'],  alpha=0.85)
        ax.bar(x+w/2,ev,w,label='Ejecutados',color=C['acc2'], alpha=0.85)
        ax.set_xticks(x); ax.set_xticklabels(lbs,rotation=30,ha='right',fontsize=8)
        ax.legend(fontsize=8)
    else:
        cats=['Generados','Ejecutados']; vs=[d['casesGen'],d['totalReqs']]
        bars=ax.bar(cats,vs,color=[C['acc'],C['acc2']],width=0.38,alpha=0.85)
        for b,v in zip(bars,vs):
            ax.text(b.get_x()+b.get_width()/2,b.get_height()+.3,
                    str(v),ha='center',fontsize=12,fontweight='bold')
    ax.set_ylabel('Cantidad',fontsize=9)
    ax.set_title('Figura 2. Casos de prueba generados vs ejecutados',
                 fontsize=10,fontweight='bold',pad=8)
    fig.tight_layout(); return to_img(fig)

# ── G3: tiempo promedio de respuesta ─────────────────────────────────────
def g3():
    fig,ax=plt.subplots(figsize=(6.4,2.9))
    if has_hist:
        lbs=[str(r.get('runId','?')) for r in H]
        vs=[r.get('avgResponseTime',0) for r in H]
        ax.plot(lbs,vs,color=C['warn'],lw=2.5,marker='s',ms=5,
                mfc='white',mew=2,zorder=3)
        ax.fill_between(range(len(vs)),vs,alpha=0.1,color=C['warn'])
        ax.set_xticks(range(len(lbs)))
        ax.set_xticklabels(lbs,rotation=30,ha='right',fontsize=8)
        ax.axhline(2000,color=C['err'],ls=':',lw=1,label='Limite 2000ms')
        ax.legend(fontsize=8)
    else:
        cats=['Promedio','Maximo']; vs=[d['avgRT'],d['maxRT']]
        bars=ax.bar(cats,vs,color=[C['warn'],C['err']],width=0.35,alpha=0.85)
        for b,v in zip(bars,vs):
            ax.text(b.get_x()+b.get_width()/2,b.get_height()+5,
                    f'{v}ms',ha='center',fontsize=11,fontweight='bold')
    ax.set_ylabel('ms',fontsize=9)
    ax.set_title('Figura 3. Tiempo promedio de respuesta de la API (ms)',
                 fontsize=10,fontweight='bold',pad=8)
    fig.tight_layout(); return to_img(fig)

# ── G4: deteccion de fallos ───────────────────────────────────────────────
def g4():
    fig,ax=plt.subplots(figsize=(6.4,2.9))
    hi=[r for r in H if r.get('detectionRate')]
    if len(hi)>1:
        lbs=[str(r.get('runId','?')) for r in hi]
        vs=[pct_val(r.get('detectionRate',0)) for r in hi]
        x=np.arange(len(lbs))
        clrs=[C['ok'] if v>=70 else C['warn'] if v>=50 else C['err'] for v in vs]
        ax.bar(x,vs,color=clrs,alpha=0.82,width=0.5)
        if len(vs)>2:
            z=np.polyfit(x,vs,1); p=np.poly1d(z)
            ax.plot(x,p(x),color=C['acc'],lw=1.8,ls='--',label='Tendencia')
            ax.legend(fontsize=8)
        ax.set_xticks(x); ax.set_xticklabels(lbs,rotation=30,ha='right',fontsize=8)
        ax.set_ylim(0,110)
    elif d.get('faults'):
        det=pct_val(d['faults'].get('detectionRate','0%'))
        cats=['Detectados','No detectados']; vs=[det,100-det]
        bars=ax.bar(cats,vs,color=[C['ok'],C['err']],width=0.35,alpha=0.85)
        for b,v in zip(bars,vs):
            ax.text(b.get_x()+b.get_width()/2,b.get_height()+1,
                    f'{v:.1f}%',ha='center',fontsize=11,fontweight='bold')
        ax.set_ylim(0,115)
    else:
        ax.text(.5,.5,'No se ejecuto inyeccion de fallos',ha='center',va='center',
                transform=ax.transAxes,fontsize=10,color=C['gray'])
    ax.set_ylabel('% deteccion',fontsize=9)
    ax.set_title('Figura 4. Tasa de deteccion de fallos inyectados',
                 fontsize=10,fontweight='bold',pad=8)
    fig.tight_layout(); return to_img(fig)

# ── G5: pie pass/fail ─────────────────────────────────────────────────────
def g5():
    fig,ax=plt.subplots(figsize=(3.3,2.8))
    if d['totalAssert']>0:
        sizes=[d['passAssert'],d['failAssert']]
        lbs=[f"Aprobadas\\n{d['passAssert']}",f"Fallidas\\n{d['failAssert']}"]
        _,_,ats=ax.pie(sizes,labels=lbs,colors=[C['ok'],C['err']],
                       autopct='%1.1f%%',startangle=90,
                       wedgeprops={'lw':2,'edgecolor':'white'},
                       textprops={'fontsize':8})
        for at in ats: at.set(fontsize=9,fontweight='bold',color='white')
    else:
        ax.text(.5,.5,'Sin datos',ha='center',va='center',
                transform=ax.transAxes,fontsize=10,color=C['gray'])
    ax.set_title('Figura 5. Assertions\\nesta ejecucion',
                 fontsize=9,fontweight='bold',pad=6)
    fig.tight_layout()
    return RLImage(io.BytesIO(
        (lambda b: (fig.savefig(b,format='png',dpi=150,bbox_inches='tight',
                                facecolor='white'),b.seek(0),plt.close(fig),b)[2])(io.BytesIO())
    ), width=3.1*inch, height=2.6*inch)

def g5():
    fig,ax=plt.subplots(figsize=(3.3,2.8))
    if d['totalAssert']>0:
        sizes=[d['passAssert'],d['failAssert']]
        lbs=[f"Aprobadas {d['passAssert']}",f"Fallidas {d['failAssert']}"]
        _,_,ats=ax.pie(sizes,labels=lbs,colors=[C['ok'],C['err']],
                       autopct='%1.1f%%',startangle=90,
                       wedgeprops={'lw':2,'edgecolor':'white'},
                       textprops={'fontsize':8})
        for at in ats: at.set(fontsize=9,fontweight='bold',color='white')
    ax.set_title('Figura 5. Assertions esta ejecucion',fontsize=9,fontweight='bold',pad=6)
    fig.tight_layout()
    buf=io.BytesIO()
    fig.savefig(buf,format='png',dpi=150,bbox_inches='tight',facecolor='white')
    buf.seek(0); plt.close(fig)
    return RLImage(buf,width=3.1*inch,height=2.6*inch)

# ── G6: cobertura ─────────────────────────────────────────────────────────
def g6():
    fig,ax=plt.subplots(figsize=(3.3,2.8))
    if has_hist:
        lbs=[str(r.get('runId','?')) for r in H]
        vs=[pct_val(r.get('coveragePercent',0)) for r in H]
        ax.bar(range(len(lbs)),vs,color=C['acc2'],alpha=0.82,width=0.55)
        ax.axhline(100,color=C['gray'],ls=':',lw=1)
        ax.set_xticks(range(len(lbs)))
        ax.set_xticklabels(lbs,rotation=45,ha='right',fontsize=7)
        ax.set_ylim(0,110)
    else:
        covered=round(d['coveragePct']*d['apiEps']/100)
        notcov=d['apiEps']-covered
        ax.barh(['Cubiertos','Sin cubrir'],[covered,notcov],
                color=[C['ok'],'#e5e7eb'],height=0.4)
        ax.set_xlim(0,d['apiEps']+1)
    ax.set_title(f"Figura 6. Cobertura endpoints\\n({d['apiEps']} en spec)",
                 fontsize=9,fontweight='bold',pad=6)
    fig.tight_layout()
    buf=io.BytesIO()
    fig.savefig(buf,format='png',dpi=150,bbox_inches='tight',facecolor='white')
    buf.seek(0); plt.close(fig)
    return RLImage(buf,width=3.1*inch,height=2.6*inch)

# ── estilos ReportLab ─────────────────────────────────────────────────────
sty=getSampleStyleSheet()
ST=ParagraphStyle('T',parent=sty['Title'],fontSize=18,spaceAfter=4,
                  textColor=hx(C['acc']),alignment=TA_CENTER)
SS=ParagraphStyle('S',parent=sty['Normal'],fontSize=10,spaceAfter=3,
                  textColor=hx(C['gray']),alignment=TA_CENTER)
SH1=ParagraphStyle('H1',parent=sty['Heading1'],fontSize=12,spaceBefore=14,
                   spaceAfter=5,textColor=hx(C['acc']))
SH2=ParagraphStyle('H2',parent=sty['Heading2'],fontSize=10,spaceBefore=8,
                   spaceAfter=3,textColor=hx(C['acc2']))
SB=ParagraphStyle('B',parent=sty['Normal'],fontSize=9,leading=13,spaceAfter=4)
SM=ParagraphStyle('Sm',parent=sty['Normal'],fontSize=7.5,textColor=hx(C['gray']))
SC=ParagraphStyle('C',parent=sty['Normal'],fontSize=8,textColor=hx(C['gray']),
                  alignment=TA_CENTER,spaceAfter=8)

def hr(): return HRFlowable(width='100%',thickness=0.5,color=hx('#cccccc'))
def sp(n=6): return Spacer(1,n)

def mtbl(rows,cw=None):
    cw=cw or [2.3*inch,1.5*inch,2.75*inch]
    t=Table(rows,colWidths=cw)
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),hx(C['acc'])),
        ('TEXTCOLOR', (0,0),(-1,0),colors.white),
        ('FONTNAME',  (0,0),(-1,0),'Helvetica-Bold'),
        ('FONTSIZE',  (0,0),(-1,-1),8.5),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,hx('#f5f5fb')]),
        ('GRID',      (0,0),(-1,-1),0.4,hx('#dddddd')),
        ('PADDING',   (0,0),(-1,-1),5),
        ('VALIGN',    (0,0),(-1,-1),'MIDDLE'),
        ('FONTNAME',  (0,1),(0,-1),'Helvetica-Bold'),
        ('TEXTCOLOR', (0,1),(0,-1),hx(C['acc'])),
    ]))
    return t

# ── documento ─────────────────────────────────────────────────────────────
doc=SimpleDocTemplate(d['outputPdf'],pagesize=letter,
    leftMargin=.85*inch,rightMargin=.85*inch,
    topMargin=.9*inch,bottomMargin=.9*inch)
story=[]

# PORTADA
story+=[sp(28),
    Paragraph('Universidad de San Carlos de Guatemala',SS),
    Paragraph('Facultad de Ingenieria - Escuela de Estudios de Postgrado',SS),
    sp(18),HRFlowable(width='100%',thickness=3,color=hx(C['acc'])),sp(12),
    Paragraph('Reporte de Metricas del Pipeline CI/CD',ST),sp(6),
    Paragraph('Generacion Automatizada de Casos de Prueba mediante LLMs',SS),
    sp(12),HRFlowable(width='100%',thickness=3,color=hx(C['acc'])),sp(28),
]
meta=Table([
    ['Run #',str(d['runId'])],['Commit',d['commitSha']],
    ['Rama',d['branch']],['Fecha',d['now'][:19].replace('T',' ')],
    ['Modelo LLM','GPT-4o (OpenAI)'],
    ['Autor','Alan Joel Morataya Escobar - USAC 2025'],
],colWidths=[1.9*inch,4.3*inch])
meta.setStyle(TableStyle([
    ('BACKGROUND',(0,0),(0,-1),hx(C['light'])),
    ('TEXTCOLOR', (0,0),(0,-1),hx(C['acc'])),
    ('FONTNAME',  (0,0),(0,-1),'Helvetica-Bold'),
    ('FONTNAME',  (1,0),(1,-1),'Helvetica'),
    ('FONTSIZE',  (0,0),(-1,-1),9),
    ('ROWBACKGROUNDS',(0,0),(-1,-1),[colors.white,hx('#fafafe')]),
    ('GRID',      (0,0),(-1,-1),0.4,hx('#dddddd')),
    ('PADDING',   (0,0),(-1,-1),7),
]))
story+=[meta,PageBreak()]

# SECCION 1: RESUMEN
det_rate=d['faults']['detectionRate'] if d['faults'] else 'N/A'
story+=[Paragraph('1. Resumen Ejecutivo',SH1),hr(),sp(6),
    mtbl([
        ['Metrica','Valor','Descripcion'],
        ['Endpoints (swagger-autogen)',str(d['apiEps']),'Rutas en swagger-output.json'],
        ['Casos generados por GPT-4o',str(d['casesGen']),'Requests en coleccion Postman'],
        ['Tiempo de generacion',f"{d['genDurSec']}s",'Fetch spec a coleccion lista'],
        ['Tokens consumidos',f"{d['tokensUsed']:,}",'Prompt + completion (OpenAI)'],
        ['Assertions ejecutadas',str(d['totalAssert']),'Total de checks Newman'],
        ['Assertions aprobadas',str(d['passAssert']),f"{d['passRate']}% tasa de exito"],
        ['Assertions fallidas',str(d['failAssert']),'Casos con problemas detectados'],
        ['Tiempo prom. respuesta',f"{d['avgRT']}ms",'Por request de Newman'],
        ['Tiempo max. respuesta',f"{d['maxRT']}ms",'Peor caso registrado'],
        ['Duracion total Newman',f"{d['totalMs']}s",'Ejecucion completa'],
        ['Cobertura de endpoints',f"{d['coveragePct']}%",'Endpoints probados / total'],
        ['Tasa deteccion fallos',det_rate,'Script inject-faults.js'],
    ]),
    sp(8),
    Paragraph(
        f'La suite generada por GPT-4o cubrio <b>{d["coveragePct"]}%</b> de los endpoints '
        f'con una tasa de exito de <b>{d["passRate"]}%</b>. '
        f'Se consumieron <b>{d["tokensUsed"]:,} tokens</b> para generar '
        f'<b>{d["casesGen"]} casos</b> en <b>{d["genDurSec"]}s</b>.',SB),
    PageBreak(),
]

# SECCION 2: GRAFICAS DE TENDENCIA
hist_note=(f'Basado en las ultimas {len(H)} ejecuciones del historial.'
           if has_hist else 'Primera ejecucion registrada. Las tendencias apareceran en el proximo run.')
story+=[Paragraph('2. Graficas de Tendencia entre Iteraciones',SH1),hr(),sp(6),
        Paragraph(hist_note,SB),sp(8),
        g1(),sp(4),g2(),sp(4),g3(),sp(4),g4(),PageBreak(),
]

# SECCION 3: ANALISIS EJECUCION ACTUAL
story+=[Paragraph('3. Analisis de la Ejecucion Actual',SH1),hr(),sp(8)]

# G5 y G6 lado a lado
side=Table([[g5(),g6()]],colWidths=[3.4*inch,3.4*inch])
side.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),
    ('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),8)]))
story+=[side,Paragraph(
    'Figura 5 (izq.): distribucion assertions aprobadas/fallidas. '
    'Figura 6 (der.): cobertura de endpoints del spec OpenAPI.',SC),sp(8)]

# Fallos detectados
if d['failedTests']:
    story+=[Paragraph('3.1 Detalle de casos fallidos',SH2),sp(4)]
    rows=[['#','Nombre del caso','Status','Error']]
    for i,ft in enumerate(d['failedTests'],1):
        rows.append([str(i),ft['name'][:48],str(ft['status']),
                     (ft['errors'][0] if ft['errors'] else '')[:65]])
    t=Table(rows,colWidths=[.25*inch,2.8*inch,.65*inch,2.85*inch])
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),hx('#fee2e2')),
        ('TEXTCOLOR', (0,0),(-1,0),hx(C['err'])),
        ('FONTNAME',  (0,0),(-1,0),'Helvetica-Bold'),
        ('FONTSIZE',  (0,0),(-1,-1),7.5),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,hx('#fff5f5')]),
        ('GRID',      (0,0),(-1,-1),0.4,hx('#fca5a5')),
        ('PADDING',   (0,0),(-1,-1),4),
    ]))
    story+=[t,sp(8)]
else:
    story+=[Paragraph('3.1 Detalle de casos fallidos',SH2),
            Paragraph('Todos los casos aprobaron en esta ejecucion.',SB),sp(8)]

# SECCION 4: INYECCION DE FALLOS
if d['faults']:
    f=d['faults']
    story+=[PageBreak(),Paragraph('4. Inyeccion de Fallos Controlada',SH1),hr(),sp(8),
        Paragraph(
            f'Se inyectaron <b>{f["faultsInjected"]} fallos controlados</b> en la API. '
            f'La suite GPT-4o detecto <b>{f["failuresDetected"]} fallos</b> de '
            f'<b>{f["assertionsTotal"]} assertions</b>: '
            f'<b>tasa de deteccion = {f["detectionRate"]}</b>.',SB),sp(8)]
    if f.get('faultsCatalog'):
        rows=[['#','Tipo','Descripcion']]
        for fc in f['faultsCatalog']:
            rows.append([str(fc['id']),fc['type'],fc['description'][:90]])
        t2=Table(rows,colWidths=[.3*inch,1.6*inch,4.65*inch])
        t2.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,0),hx('#fef3c7')),
            ('TEXTCOLOR', (0,0),(-1,0),hx('#92400e')),
            ('FONTNAME',  (0,0),(-1,0),'Helvetica-Bold'),
            ('FONTSIZE',  (0,0),(-1,-1),8),
            ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,hx('#fffbeb')]),
            ('GRID',      (0,0),(-1,-1),0.4,hx('#fde68a')),
            ('PADDING',   (0,0),(-1,-1),5),
        ]))
        story+=[t2]

# PIE
story+=[sp(20),HRFlowable(width='100%',thickness=0.5,color=hx('#cccccc')),sp(4),
    Paragraph(
        f'Generado automaticamente por api-test-generator | '
        f'Alan Joel Morataya Escobar | USAC Postgrado 2025 | '
        f'Run #{d["runId"]} | {d["now"][:10]}',SM)]

doc.build(story)
print('PDF generado:', d['outputPdf'])
`;

const pyPath = path.join(REPORTS_DIR, '_gen_pdf.py');
fs.writeFileSync(pyPath, py);

console.log('📊 Instalando matplotlib + generando PDF con gráficas reales...');
try {
  execSync(
    'pip install reportlab matplotlib numpy --break-system-packages -q' +
    ` && python3 ${pyPath} ${dataPath}`,
    { stdio: 'inherit' }
  );
  console.log(`\n✅ PDF listo: ${OUTPUT_PDF}`);
} catch (err) {
  console.error('❌ Error generando PDF:', err.message);
  process.exit(1);
} finally {
  try { fs.unlinkSync(pyPath); fs.unlinkSync(dataPath); } catch {}
}
