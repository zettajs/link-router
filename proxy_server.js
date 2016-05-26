var Proxy = require('./proxy');
var RouterClient = require('./clients/router_client');
var ServiceRegistryClient = require('./clients/service_registry_client');
var VersionClient = require('./clients/version_client');
var StatsClient = require('stats-client');

var port = process.env.PORT || 4001;

var opts = {
  host: process.env.COREOS_PRIVATE_IPV4
};

// allow a list of peers to be passed, overides COREOS_PRIVATE_IPV4
if (process.env.ETCD_PEER_HOSTS) {
  opts.host = process.env.ETCD_PEER_HOSTS.split(',');
}

var tenantMgmtApi = process.env.TENANT_MANAGEMENT_API;
if (!tenantMgmtApi) {
  throw new Error('Must supply a tenant management api env param with ENANT_MANAGEMENT_API');
}

var serviceRegistryClient = new ServiceRegistryClient(opts);
var routerClient = new RouterClient(opts);
var versionClient = new VersionClient(opts);
var statsdHost = process.env.COREOS_PRIVATE_IPV4 || 'localhost';
var statsClient = new StatsClient(statsdHost + ':8125', {  routerHost: process.env.COREOS_PRIVATE_IPV4 });

var proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient, tenantMgmtApi);
proxy.listen(port, function() {
  console.log('proxy listening on http://localhost:' + port);
});

