const express = require('express');
const router = express.Router();

let orders = [
  { id: 1, userId: 1, productId: 1, quantity: 1, status: 'confirmed', total: 1299.99, createdAt: new Date().toISOString() },
];
let nextId = 2;

/**
 * @openapi
 * /api/orders:
 *   get:
 *     summary: Listar todas las órdenes
 *     tags: [Orders]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, confirmed, shipped, delivered, cancelled]
 *       - in: query
 *         name: userId
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Lista de órdenes
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Order'
 */
router.get('/', (req, res) => {
  let result = [...orders];
  if (req.query.status) result = result.filter(o => o.status === req.query.status);
  if (req.query.userId) result = result.filter(o => o.userId === parseInt(req.query.userId));
  res.json(result);
});

/**
 * @openapi
 * /api/orders/{id}:
 *   get:
 *     summary: Obtener orden por ID
 *     tags: [Orders]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Orden encontrada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Order'
 *       404:
 *         description: Orden no encontrada
 */
router.get('/:id', (req, res) => {
  const order = orders.find(o => o.id === parseInt(req.params.id));
  if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
  res.json(order);
});

/**
 * @openapi
 * /api/orders:
 *   post:
 *     summary: Crear una nueva orden
 *     tags: [Orders]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, productId, quantity]
 *             properties:
 *               userId:
 *                 type: integer
 *               productId:
 *                 type: integer
 *               quantity:
 *                 type: integer
 *                 minimum: 1
 *     responses:
 *       201:
 *         description: Orden creada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Order'
 *       400:
 *         description: Datos inválidos
 */
router.post('/', (req, res) => {
  const { userId, productId, quantity } = req.body;

  if (!userId || !productId || !quantity) {
    return res.status(400).json({ error: 'userId, productId y quantity son requeridos' });
  }
  if (quantity < 1) {
    return res.status(400).json({ error: 'La cantidad mínima es 1' });
  }

  const newOrder = {
    id: nextId++,
    userId: parseInt(userId),
    productId: parseInt(productId),
    quantity: parseInt(quantity),
    status: 'pending',
    total: null, // Se calcularía consultando el precio del producto
    createdAt: new Date().toISOString(),
  };
  orders.push(newOrder);
  res.status(201).json(newOrder);
});

/**
 * @openapi
 * /api/orders/{id}/status:
 *   patch:
 *     summary: Actualizar el estado de una orden
 *     tags: [Orders]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, confirmed, shipped, delivered, cancelled]
 *     responses:
 *       200:
 *         description: Estado actualizado
 *       400:
 *         description: Estado inválido
 *       404:
 *         description: Orden no encontrada
 */
router.patch('/:id/status', (req, res) => {
  const index = orders.findIndex(o => o.id === parseInt(req.params.id));
  if (index === -1) return res.status(404).json({ error: 'Orden no encontrada' });

  const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
  const { status } = req.body;

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Estado inválido. Use: ${validStatuses.join(', ')}` });
  }

  orders[index].status = status;
  res.json(orders[index]);
});

/**
 * @openapi
 * /api/orders/{id}:
 *   delete:
 *     summary: Cancelar/eliminar una orden
 *     tags: [Orders]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Orden eliminada
 *       404:
 *         description: Orden no encontrada
 */
router.delete('/:id', (req, res) => {
  const index = orders.findIndex(o => o.id === parseInt(req.params.id));
  if (index === -1) return res.status(404).json({ error: 'Orden no encontrada' });

  const deleted = orders.splice(index, 1)[0];
  res.json({ message: 'Orden eliminada', order: deleted });
});

module.exports = router;
