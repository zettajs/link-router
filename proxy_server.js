var Proxy = require('./proxy');
var RouterClient = require('./router_client');
var ServiceRegistryClient = require('./service_registry_client');
var VersionClient = require('./version_client');
var StatsClient = require('stats-client');

var port = process.env.PORT || 4001;

var opts = {
  host: process.env.COREOS_PRIVATE_IPV4
};

// allow a list of peers to be passed, overides COREOS_PRIVATE_IPV4
if (process.env.ETCD_PEER_HOSTS) {
  opts.host = process.env.ETCD_PEER_HOSTS.split(',');
}

var serviceRegistryClient = new ServiceRegistryClient(opts);

var routerClient = new RouterClient(opts);

var versionClient = new VersionClient(opts);

var statsClient = new StatsClient('localhost:8125', {  host: opts.host });

var proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient);
proxy.listen(port, function() {
  console.log('proxy listening on http://localhost:' + port);
});

['SIGINT', 'SIGTERM'].forEach(function(signal) {
  process.on(signal, function() {
    
    var count = proxy._peerSockets.length;
    proxy._peerSockets.forEach(function(peer) {
      routerClient.remove(peer.tenantId, peer.targetName, function() {
        count--;
        if (count === 0) {
          process.exit();
        }
      })
    });
    
    if (count === 0) {
      process.exit();
    }

  });
});

