var AWS = require('aws-sdk');
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
var jwtPlaintextKeys = null;

if (!process.env.JWT_CIPHER_TEXT) {
  console.log('Starting without JWT')

  if (process.env.JWT_PLAIN_TEXT) {
    var keys = process.env.JWT_PLAIN_TEXT.split(',');
    if (keys.length !== 2) {
      throw new Error('Expecting two comma seperated keys');
    }
    jwtPlaintextKeys = { internal: keys[0], external: keys[1] };
  }
  
  startServer();
} else {
  console.log('Decrypting jwt key');

  AWS.config.update({ region: process.env.AWS_REGION });
  var kms = new AWS.KMS();
  
  var opts = {
    CiphertextBlob: new Buffer(process.env.JWT_CIPHER_TEXT, 'hex'),
    EncryptionContext: {
      stackName: process.env.ZETTA_STACK
    }
  };
  kms.decrypt(opts, function(err, data) {
    if (err) {
      console.error(err);
      process.exit(1);
      return;
    }

    var keys = data.Plaintext.toString().split(',');
    if (keys.length !== 2) {
      throw new Error('Expecting two comma seperated keys.');
    }
    jwtPlaintextKeys = { internal: keys[0], external: keys[1] };
    startServer();
  });
}

function startServer() {
  var proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient, tenantMgmtApi, jwtPlaintextKeys);
  proxy.listen(port, function() {
    console.log('proxy listening on http://localhost:' + port);
  });
}

