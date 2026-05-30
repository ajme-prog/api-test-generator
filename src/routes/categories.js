const express = require('express');
const router = express.Router();

let categories = [
  { id: 1, name: 'Electrónica', description: 'Dispositivos electrónicos' },
  { id: 2, name: 'Periféricos', description: 'Accesorios de computadora' },
];
let nextId = 3;

/**
 * @openapi
 * /api/categories:
 *   get:
 *     summary: Listar todas las categorías
 *     tags: [Categories]
 *     responses:
 *       200:
 *         description: Lista de categorías
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Category'
 */
router.get('/', (req, res) => {
  res.json(categories);
});

/**
 * @openapi
 * /api/categories:
 *   post:
 *     summary: Crear una categoría
 *     tags: [Categories]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 2
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Categoría creada
 *       400:
 *         description: Datos inválidos
 */
router.post('/', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name es requerido' });
  if (name.length < 2) return res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres' });
  const cat = { id: nextId++, name, description: description || '' };
  categories.push(cat);
  res.status(201).json(cat);
});

/**
 * @openapi
 * /api/categories/{id}:
 *   delete:
 *     summary: Eliminar una categoría
 *     tags: [Categories]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Categoría eliminada
 *       404:
 *         description: Categoría no encontrada
 */
router.delete('/:id', (req, res) => {
  const index = categories.findIndex(c => c.id === parseInt(req.params.id));
  if (index === -1) return res.status(404).json({ error: 'Categoría no encontrada' });
  const deleted = categories.splice(index, 1)[0];
  res.json({ message: 'Categoría eliminada', category: deleted });
});

module.exports = router;
