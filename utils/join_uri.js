var url = require('url');
var path = require('path');
var parseUri = require('./parse_uri');

module.exports = function(request, pathname) {
  var uri = parseUri(request);
  var parsed = url.parse(uri);
  parsed.pathname = path.join(parsed.pathname, pathname).replace(/\\/g, '/');
  return url.format(parsed);
};
