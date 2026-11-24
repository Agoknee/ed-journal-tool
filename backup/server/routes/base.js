const path = require('node:path');
const express = require('express');

const { isLoggedIn, loginRoute } = require('../auth');
const apiRoutes = require('./api');

const router = express.Router();

// # Add login endpoints
router.post('/login', loginRoute);
router.get('/login', (req, res) => {
  res.send(`
    <html>
    <body>
    <form action="/login" method="POST">
      Username: <input name="username"></input><br />
      Password: <input name="password"></input><br />
      <input type="submit" value="Submit" />
    </form>
    </body>
    </html>
  `);
});

// # Add secure API endpoints
router.use('/api', isLoggedIn, apiRoutes);

// # Serve static client page for base routes
router.use(['/'], express.static(path.join(__dirname, '../public')));

module.exports = router;
