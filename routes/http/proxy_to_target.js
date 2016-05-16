var http = require('http');
var url = require('url');
var Rels = require('zetta-rels');
var getTenantId = require('./../../utils/get_tenant_id');
var sirenResponse = require('./../../utils/siren_response');
var parseUri = require('./../../utils/parse_uri');
var joinUri = require('./../../utils/join_uri');
var statusCode = require('./../../utils/status_code');

var TargetProxy = module.exports = function(proxy) {
  this.name = 'proxy'; // for stats logging
  this.proxy = proxy;
};

TargetProxy.prototype.handler = function(request, response, parsed) {
  var self = this;
  var targetName;
  var tenantId = getTenantId(request);

  var match = /^\/servers\/(.+)$/.exec(request.url);
  if (match) {
    targetName = decodeURIComponent(/^\/servers\/(.+)$/.exec(parsed.pathname)[1].split('/')[0]);
  } else {
    response.statusCode = 404;
    response.end();
    return;
  }
  
  self.proxy.lookupPeersTarget(tenantId, targetName, function(err, serverUrl) {
    if (err) {
      response.statusCode = 404;
      response.end();
      return;
    }

    // Set targetname for stats
    request._targetName = targetName;
    
    var server = url.parse(serverUrl);

    var options = {
      method: request.method,
      headers: request.headers,
      hostname: server.hostname,
      port: server.port,
      path: parsed.path
    };

    var target = http.request(options);

    // close target req if client is closed before target finishes
    response.on('close', function() {
      target.abort();
    });

    target.on('response', function(targetResponse) {
      response.statusCode = targetResponse.statusCode;

      Object.keys(targetResponse.headers).forEach(function(header) {
        response.setHeader(header, targetResponse.headers[header]);
      });

      targetResponse.pipe(response);
    });

    target.on('error', function() {
      response.statusCode = 500;
      response.end();
    });

    request.pipe(target);    
  });
};
