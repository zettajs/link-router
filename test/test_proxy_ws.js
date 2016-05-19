var assert = require('assert');
var request = require('supertest');
var zetta = require('zetta');
var zrx = require('zrx');
var Photocell = require('zetta-photocell-mock-driver');
var StatsClient = require('stats-client');
var WebSocket = require('ws');

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

describe('Proxy Websockets', function() {
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
    target.silent();
    hub.silent();

    target.name('target.1');
    hub.name('hub.1');
    hub.use(Photocell);

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

        hub.link(proxyUrl);

        hub.listen(0, function() {
          var called = false;
          hub.pubsub.subscribe('_peer/connect', function(topic, data) {
            if (!called) {
              called = true;
              done();
            }
          });
        });
      });
    });

  });  

  afterEach(function(done) {
    target.httpServer.server.close();
    hub.httpServer.server.close();
    proxy._server.close();
    if(newTarget) {
      newTarget.httpServer.server.close();
    }
    done();  
  });

  it('will should recieve photocell data', function(done) {
    var c = zrx()
      .load(proxyUrl)
      .peer('hub.1')
      .device(function(d) { return d.type === 'photocell'; })
      .stream('intensity')
      .subscribe(function() {
        c.dispose();
        done();
      });
  })

  it('will properly send close ACK when ws closes', function(done) {
    var c = zrx()
      .load(proxyUrl)
      .peer('hub.1')
      .device(function(d) { return d.type === 'photocell'; })
      .stream('intensity')
      .subscribe(function(data) {
        c.dispose();
        var wsUrl = proxyUrl.replace('http', 'ws') + '/servers/hub.1/events?topic=' + data.topic;
        var ws = new WebSocket(wsUrl);
        ws.on('open', function open() {
          ws.close();
        });
        ws.on('close', function(data, flags) {
          done();
        });
      });  
  })

  it('will respond to ping requests', function(done) {
    var c = zrx()
      .load(proxyUrl)
      .peer('hub.1')
      .device(function(d) { return d.type === 'photocell'; })
      .stream('intensity')
      .subscribe(function(data) {
        c.dispose();

        var wsUrl = proxyUrl.replace('http', 'ws') + '/servers/hub.1/events?topic=' + data.topic;
        var ws = new WebSocket(wsUrl);
        ws.on('open', function open() {
          ws.ping('Application Data');
          ws.on('pong', function(data, flags) {
            assert.equal(data, 'Application Data');
            done();
          })
        });
        
      });  
  })


  it('ws should not disconnect after etcd router updates', function(done) {
    var count = 0;
    var c = zrx()
        .load(proxyUrl)
        .peer('hub.1')
        .device(function(d) { return d.type === 'photocell'; })
        .stream('intensity')
        .subscribe(function(data) {
          c.dispose();
          if (count === 0) {
            var wsUrl = proxyUrl.replace('http', 'ws') + '/servers/hub.1/events?topic=' + data.topic;
            var ws = new WebSocket(wsUrl);
            ws.on('open', function open() {
              etcd._trigger('/router/zetta', []);        
              setTimeout(function() {
                assert.equal(ws.readyState, WebSocket.OPEN);
                done();
              }, 10);
            });
            
            count++;
          }
        });
  })
  
  it('second ws client connecting should continue to recv data after first client disconnects', function(done) {
    var createClient = function(cb) {
      return zrx()
        .load(proxyUrl)
        .peer('hub.1')
        .device(function(d) { return d.type === 'photocell'; })
        .stream('intensity')
        .subscribe(cb);
    }
    
    var c1Count = 0;
    var c2Count = 0;
    var c1 = createClient(function() { c1Count++; });
    var c2 = createClient(function() { c2Count++; });

    setTimeout(function() {
      c1.dispose();
      c2Count=0;
      setTimeout(function() {
        if (c2Count === 0) {
          throw new Error('Havnt recieved anymore ws messages after first client disconnects')
        }
        done();
      }, 200);
    }, 200)
  });

});
