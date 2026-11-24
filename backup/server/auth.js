const username = process.env.EDJP_USERNAME || 'user';
const password = process.env.EDJP_PASSWORD || 'password';

function getAppToken(user) {
  // generate/save random token
  return 'testToken';
}

export function isLoggedIn(req, res, next) {
  if (req.session.user) return next();

  try {
    const authHeader = req.get('Authorization');
    const { user, appToken } = JSON.parse(atob(authHeader.slice(6)));
    if (getAppToken(user) === appToken) {
      req.session.user = user;
      req.session.appToken = appToken;
      return next();
    }
  } catch {}

  res.status(401).send('Unauthorized');
}

export function loginRoute(req, res, next) {
  if (req.body?.username === username && req.body?.password === password) {
    req.session.user = username;
    req.session.appToken = getAppToken(username);
    res.json({ user: req.session.user, appToken: req.session.appToken });
  } else {
    res.status(401).send('Unauthorized');
  }
}
