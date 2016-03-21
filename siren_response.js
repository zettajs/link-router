module.exports = function(res, code, json) {
  if (typeof json === 'object' && !Buffer.isBuffer(json)) {
    try {
      var bodyText = JSON.stringify(json);
    } catch(err) {
      console.error('JSON.stringify:', err);
      res.statusCode = 500;
      res.end();
      return;
    }
  } else {
    var bodyText = json;
  }

  res.statusCode = code;
  res.setHeader('Content-Type', 'application/vnd.siren+json');
  res.setHeader('Content-Length', bodyText.length);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(bodyText);
}
