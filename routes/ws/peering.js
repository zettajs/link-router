var url = require('url');
var path = require('path');
var http = require('http');
var getTenantId = require('./../../utils/get_tenant_id');
var getBody = require('../../utils/get_body');

var Peering = module.exports = function(proxy) {
  this._proxy = proxy;
};

Peering.prototype.handler = function(request, socket) {
  var tenantId = getTenantId(request);

  var parsed = url.parse(this._proxy._tenantMgmtApi);
  var options = {
    hostname: parsed.hostname,
    port: parsed.port,
    method: 'POST',
    path: path.join('/tenants',  tenantId, 'target')
  };
  
  var req = http.request(options, function(response) {
    // Rewrite Location to include original request path and JWT
    if (response.headers.location) {
      var serverUrlParsed = url.parse(response.headers.location);
      var requestParsed = url.parse(request.url, true);
      requestParsed.host = serverUrlParsed.host;
      requestParsed.port = serverUrlParsed.port;
      requestParsed.protocol = serverUrlParsed.protocol;
      delete requestParsed.search;
      requestParsed.query.jwt = '12345'; // jwt access token
      response.headers.location = url.format(requestParsed);
    }

    var code = response.statusCode;
    var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];
    var headers = Object.keys(response.headers).map(function(header) {
      return header + ': ' + response.headers[header];
    });
    
    socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
    response.pipe(socket);
  });

  req.once('error', function(err) {
    socket.end('HTTP/1.1 500 Server Error\r\n\r\n\r\n');
  });

  req.end();
};
