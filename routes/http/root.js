var Rels = require('zetta-rels');
var getTenantId = require('./../../utils/get_tenant_id');
var sirenResponse = require('./../../utils/siren_response');
var parseUri = require('./../../utils/parse_uri');
var joinUri = require('./../../utils/join_uri');

var Root = module.exports = function(proxy) {
  this.proxy = proxy;
};

Root.prototype.handler = function(request, response, parsed) {
  var self = this;
  var tenantId = getTenantId(request);

  var startTime = new Date().getTime();

  var body = {
    class: ['root'],
    links: [
      {
        rel: ['self'],
        href: parseUri(request)
      },
      {
        rel: [ Rels.peerManagement ],
        href: joinUri(request, '/peer-management')
      },
      {
        rel: [ Rels.events ],
        href: joinUri(request, '/events').replace(/^http/,'ws')
      }
    ]
  };

  var clientAborted = false;
  request.on('close', function() {
    clientAborted = true;
  });

  var entities = this.proxy._routerClient.findAll(tenantId, function(err, results) {
    if (clientAborted) {
      return;
    }

    if (results) {
      results.forEach(function(peer) {
        body.links.push({
          title: peer.name,
          rel: [Rels.peer, Rels.server],
          href: joinUri(request, '/servers/' + peer.name)
        });
      });
    }

    body.actions = [
      { 
        name: 'query-devices',
        method: 'GET',
        href: parseUri(request),
        type: 'application/x-www-form-urlencoded',
        fields: [
          { name: 'server', type: 'text' },
          { name: 'ql', type: 'text' }
        ]
      }
    ];

    var duration = new Date().getTime()-startTime;
    self.proxy._statsClient.timing('http.req.root', duration, { tenant: tenantId });
    self.proxy._statsClient.increment('http.req.root.status.2xx', { tenant: tenantId });

    sirenResponse(response, 200, body);
  });
};
