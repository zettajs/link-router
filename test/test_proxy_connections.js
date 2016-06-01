var http = require('http');
var assert = require('assert');
var request = require('supertest');
var zetta = require('zetta');
var StatsClient = require('stats-client');
var MemoryDeviceRegistry = require('./mocks/memory_device_registry');
var MemoryPeerRegistry = require('./mocks/memory_peer_registry');
var MockEtcd = require('./mocks/mock_etcd');
var VersionClient = require('../clients/version_client');
var ServiceRegistryClient = require('../clients/service_registry_client');
var RouterClient = require('../clients/router_client');
var TargetMonitor = require('../monitor/service');
var Proxy = require('../proxy');

// Fix for Proxy subscribing to SIGs on every test
process.setMaxListeners(0);

describe('Proxy Connection', function() {
  var hub = null;
  var proxy = null;
  var etcd = null;
  var target = null;
  var proxyUrl = null;
  var newTarget = null;
  var serviceRegistryClient = null;
  
  beforeEach(function(done) {
    etcd = new MockEtcd();

    etcd.set('/zetta/version', '{"version":"1"}');
    
    var versionClient = new VersionClient({ client: etcd });
    serviceRegistryClient = new ServiceRegistryClient({ client: etcd });
    var routerClient = new RouterClient({ client: etcd });

    target = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });
    hub = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });

    hub.use(function(server) {
      server.onPeerRequest(function(request) {
        request.use(function(handle) {
          handle('request', function(pipeline) {
            return pipeline.map(function(env) {
              env.request.headers['X-Apigee-IoT-Tenant-ID'] = 'test';
              return env;
            });
          });
        });
      });
    });

    target.silent();
    hub.silent();

    target.name('target.1');
    hub.name('hub.1');

    target.listen(0, function(err) {
      if(err) {
        return done(err);
      }

      var cloud = 'http://localhost:' + target.httpServer.server.address().port;
      serviceRegistryClient.add('cloud-target', cloud, '1');
      var statsClient = new StatsClient('localhost:8125');
      var monitor = new TargetMonitor(serviceRegistryClient, { disabled: true });
      proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient, monitor); 
      proxy.listen(0, function(err) {
        if(err) {
          return done(err);
        } 

        proxyUrl = 'http://localhost:' + proxy._server.address().port;

        done();
      });
    });

  });  

  afterEach(function(done) {
    try { 
      target.httpServer.server.close();
      hub.httpServer.server.close();
      proxy._server.close();
      if(newTarget) {      
        newTarget.httpServer.server.close();
      }
    } catch(err) {};
    done();
  });
   
  it('will properly route peering connections', function(done) {
    hub.link(proxyUrl);
    var count = 0;
    function checkConnectionCount() {
      if(count == 2) {
        done(); 
      }  
    }

    hub.pubsub.subscribe('_peer/connect', function(topic, data) {
      count++;
      checkConnectionCount();
    });

    target.pubsub.subscribe('_peer/connect', function(topic, data) {
      count++;
      checkConnectionCount();
    });

    hub.listen(0);
  });

  it('will properly route to new versions.', function(done) {
    var count = 0;
    newTarget = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() })
    function checkConnectionCount() {
      if(count == 2) {
        done(); 
      }  
    }

    newTarget.name('target.2');
    newTarget.silent();


    newTarget.listen(0, function(err) {
      if(err) {
        return done(err);
      }
      
      var cloud = 'http://localhost:' + newTarget.httpServer.server.address().port;
      serviceRegistryClient.add('cloud-target', cloud, '2');
      etcd.keyValuePairs['/zetta/version'] = { value: '{"version":"2"}' };
      etcd._trigger('/zetta/version', '{"version":"2"}');
      etcd._trigger('/services/zetta', '{"foo":"foo"}');

      hub.pubsub.subscribe('_peer/connect', function(topic, data) {
        count++;
        checkConnectionCount();
      });

      newTarget.pubsub.subscribe('_peer/connect', function(topic, data) {
        count++;
        checkConnectionCount();
      });

      hub.link(proxyUrl);
      hub.listen(0);
    });
      
  });

  it('will return a 503 when no unallocated servers are available', function(done) {
    etcd.keyValuePairs.services.zetta = {};
    request(proxy._server)
      .get('/peers/test?connectionId=1234567890')
      .set('Upgrade', 'websocket')
      .set('Connection', 'Upgrade')
      .set('Sec-WebSocket-Version', '13')
      .set('Sec-WebSocket-Key', new Buffer('13' + '-' + Date.now()).toString('base64'))
      .set('X-Apigee-IoT-Tenant-Id', 'no-tenant-id')
      .expect(503)
      .end(done);
  });

  it('will return 400 when target returns a 400 on peering', function(done) {
    var server = http.createServer(function(req, res) {
      res.statusCode = 400;
      res.end();
    });
    server.on('upgrade', function(request, socket, head) {
      socket.end('HTTP/1.1 400 Some Error\r\n\r\n\r\n');
    });
    
    server.listen(0, function(err) {
      var port = server.address().port;
      etcd.keyValuePairs.services.zetta = {};
      
      etcd.keyValuePairs.services.zetta['localhost:' + port] = JSON.stringify({
        type: 'cloud-target',
        url: 'http://localhost:' + port,
        created: new Date(),
        version: "1"
      });
      
      request(proxy._server)
        .get('/peers/test?connectionId=1234567890')
        .set('Upgrade', 'websocket')
        .set('Connection', 'Upgrade')
        .set('Sec-WebSocket-Version', '13')
        .set('Sec-WebSocket-Key', new Buffer('13' + '-' + Date.now()).toString('base64'))
        .expect(400)
        .end(done);
    });    
  });
  

  it('will allocate 2 targets per tenant', function(done) {
    var target2 = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });
    target2.silent();
    target2.name('target.2');

    target2.listen(0, function(err) {
      if(err) {
        return done(err);
      }

      var cloud = 'http://localhost:' + target2.httpServer.server.address().port;
      serviceRegistryClient.add('cloud-target', cloud, '1');

      etcd._trigger('/services/zetta', '{"foo":"foo"}');

      hub.pubsub.subscribe('_peer/connect', function(topic, data) {
        assert.equal(proxy._servers['test'].length, 2);
        done();
      });

      hub.link(proxyUrl);
      hub.listen(0);
    });

  });

  it('will allocate last remaining target per tenant', function(done) {
    hub.link(proxyUrl);
    hub.listen(0);

    hub.pubsub.subscribe('_peer/connect', function(topic, data) {
      assert.equal(proxy._servers['test'].length, 1);
      done();
    });
  });
});
