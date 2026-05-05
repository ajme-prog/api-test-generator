const express = require('express');
const router = express.Router();

let products = [
  { id: 1, name: 'Laptop Pro 15', price: 1299.99, stock: 50, category: 'Electrónica' },
  { id: 2, name: 'Teclado Mecánico RGB', price: 89.99, stock: 200, category: 'Periféricos' },
  { id: 3, name: 'Monitor 4K 27"', price: 449.99, stock: 30, category: 'Electrónica' },
];
let nextId = 4;

/**
 * @openapi
 * /api/products:
 *   get:
 *     summary: Listar todos los productos
 *     tags: [Products]
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filtrar por categoría
 *       - in: query
 *         name: minPrice
 *         schema:
 *           type: number
 *         description: Precio mínimo
 *       - in: query
 *         name: maxPrice
 *         schema:
 *           type: number
 *         description: Precio máximo
 *       - in: query
 *         name: inStock
 *         schema:
 *           type: boolean
 *         description: Solo productos con stock disponible
 *     responses:
 *       200:
 *         description: Lista de productos
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Product'
 */
router.get('/', (req, res) => {
  let result = [...products];
  if (req.query.category) result = result.filter(p => p.category === req.query.category);
  if (req.query.minPrice) result = result.filter(p => p.price >= parseFloat(req.query.minPrice));
  if (req.query.maxPrice) result = result.filter(p => p.price <= parseFloat(req.query.maxPrice));
  if (req.query.inStock === 'true') result = result.filter(p => p.stock > 0);
  res.json(result);
});

/**
 * @openapi
 * /api/products/{id}:
 *   get:
 *     summary: Obtener producto por ID
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Producto encontrado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       404:
 *         description: Producto no encontrado
 */
router.get('/:id', (req, res) => {
  const product = products.find(p => p.id === parseInt(req.params.id));
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(product);
});

/**
 * @openapi
 * /api/products:
 *   post:
 *     summary: Crear un producto
 *     tags: [Products]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, price, stock]
 *             properties:
 *               name:
 *                 type: string
 *               price:
 *                 type: number
 *                 minimum: 0.01
 *               stock:
 *                 type: integer
 *                 minimum: 0
 *               category:
 *                 type: string
 *     responses:
 *       201:
 *         description: Producto creado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       400:
 *         description: Datos inválidos
 */
router.post('/', (req, res) => {
  const { name, price, stock, category } = req.body;

  if (!name || price === undefined || stock === undefined) {
    return res.status(400).json({ error: 'name, price y stock son requeridos' });
  }
  if (price <= 0) return res.status(400).json({ error: 'El precio debe ser mayor a 0' });
  if (stock < 0) return res.status(400).json({ error: 'El stock no puede ser negativo' });

  const newProduct = { id: nextId++, name, price: parseFloat(price), stock: parseInt(stock), category: category || 'General' };
  products.push(newProduct);
  res.status(201).json(newProduct);
});

/**
 * @openapi
 * /api/products/{id}:
 *   patch:
 *     summary: Actualizar stock de un producto
 *     tags: [Products]
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
 *             required: [stock]
 *             properties:
 *               stock:
 *                 type: integer
 *                 minimum: 0
 *     responses:
 *       200:
 *         description: Stock actualizado
 *       404:
 *         description: Producto no encontrado
 */
router.patch('/:id', (req, res) => {
  const index = products.findIndex(p => p.id === parseInt(req.params.id));
  if (index === -1) return res.status(404).json({ error: 'Producto no encontrado' });

  const { stock } = req.body;
  if (stock === undefined || stock < 0) {
    return res.status(400).json({ error: 'Stock inválido' });
  }
  products[index].stock = parseInt(stock);
  res.json(products[index]);
});

/**
 * @openapi
 * /api/products/{id}:
 *   delete:
 *     summary: Eliminar un producto
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Producto eliminado
 *       404:
 *         description: Producto no encontrado
 */
router.delete('/:id', (req, res) => {
  const index = products.findIndex(p => p.id === parseInt(req.params.id));
  if (index === -1) return res.status(404).json({ error: 'Producto no encontrado' });

  const deleted = products.splice(index, 1)[0];
  res.json({ message: 'Producto eliminado', product: deleted });
});

module.exports = router;
