const http = require('node:http');
const express = require('express');
const session = require('express-session');
const baseRoutes = require('./routes/base');

const app = express();

app.use(session({
  secret: 'supersecretsessionkey',
  cookie: { maxAge: 60000 },
  resave: false,
  saveUninitialized: true,
}));
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ extended: true, limit: "200mb" }));

app.use('/', baseRoutes);

const httpServer = http.createServer(app);
const server = httpServer.listen(process.env.PORT || 4000, () => {
  console.log(`Server listening on port: ${process.env.PORT || 4000}`);
});
