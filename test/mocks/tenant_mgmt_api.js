var http = require('http');

var TenantMgmtApi = module.exports = function(etcd) {
  this._etcd = etcd;
  this._server = http.createServer(this.onRequest.bind(this));
};

TenantMgmtApi.prototype.href = function() {
  return 'http://localhost:' + this._server.address().port;
};

TenantMgmtApi.prototype.listen = function() {
  this._server.listen.apply(this._server, arguments);
};

TenantMgmtApi.prototype.onRequest = function(request, response) {
  var self = this;
  var targetCount = 2;
  var tenantId  = /\/tenants\/(.+)\/target$/.exec(request.url)[1];

  this._etcd.get('/zetta/version', { recursive: true }, function(err, results) {
    var version = JSON.parse(results.node.value).version;
    self._etcd.get('/services/zetta', { recursive: true }, function(err, results) {

      if (results.node.nodes) {
        var nodes = results.node.nodes.map(function(node) {
          node.value = JSON.parse(node.value);
          return node;
        });
      } else {
        var nodes = [];
      }
      
      var allocated = nodes.filter(function(node) {
        return node.value.tenantId === tenantId && node.value.version === version;
      });

      var unallocated = nodes.filter(function(node) {
        return !node.value.tenantId && node.value.version === version;
      });


      while (allocated.length < targetCount && unallocated.length > 0) {
        var node = unallocated.pop();
        node.value.tenantId = tenantId;
        self._etcd.set(node.key, JSON.stringify(node.value));
        self._etcd._trigger('/services/zetta', []);
        
        allocated.push(node);
      }

      if (allocated.length === 0) {
        response.statusCode = 503;
        response.end();
        return;
      }

      response.statusCode = 302;
      response.setHeader('Location', allocated[0].value.url);
      response.end();
    });
  });
};

