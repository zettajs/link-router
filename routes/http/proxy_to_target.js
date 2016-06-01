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

    self.proxy.proxyToTarget(serverUrl, request, response);
  });
};
