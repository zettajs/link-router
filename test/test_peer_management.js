var assert = require('assert');
var url = require('url');
var request = require('supertest');
var zetta = require('zetta');
var Led = require('zetta-led-mock-driver');
var WebSocket = require('ws');
var StatsClient = require('stats-client');

var MemoryDeviceRegistry = require('./mocks/memory_device_registry');
var MemoryPeerRegistry = require('./mocks/memory_peer_registry');
var MockEtcd = require('./mocks/mock_etcd');
var VersionClient = require('../version_client');
var ServiceRegistryClient = require('../service_registry_client');
var RouterClient = require('../router_client');
var TargetMonitor = require('../monitor/service');
var Proxy = require('../proxy');

function getBody(fn) {
  return function(res) {
    try {
      if(res.text) {
        var body = JSON.parse(res.text);
      } else {
        var body = '';
      }
    } catch(err) {
      throw new Error('Failed to parse JSON body'); 
    }
    
    fn(res, body);  
  }  
}

describe('Peer Management API', function() {
  var proxy = null;
  var proxyUrl = null;
  var hubs = [];
  var targets = [];
  var etcd = null;

  beforeEach(function(done) {
    etcd = new MockEtcd();

    etcd.set('/zetta/version', '{"version":"1"}');    
    var versionClient = new VersionClient({ client: etcd });
    var serviceRegistryClient = new ServiceRegistryClient({ client: etcd });
    var routerClient = new RouterClient({ client: etcd });

    // start targets
    var targetsStarted = 0;

    [0, 1].forEach(function(i) {
      var target = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });
      targets.push(target);

      target.name('target.' + i)
      target.silent();
      
      target.listen(0, function(err) {
        if(err) {
          return done(err);
        }

        serviceRegistryClient.add('cloud-target', 'http://localhost:' + target.httpServer.server.address().port, '1');
        targetsStarted++;
        if (targetsStarted === 2) {
          startProxy();
        }
      });
    })
    
    function startProxy() {
      var statsClient = new StatsClient('localhost:8125');
      var monitor = new TargetMonitor(serviceRegistryClient, { disabled: true });
      proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient, monitor);
      proxy.listen(0, function(err) {
        if(err) {
          return done(err);
        } 

        proxyUrl = 'http://127.0.0.1:' + proxy._server.address().port;
        startHubs();
      });
    }

    function startHubs() {
      var hubsStarted = 0;
      [0, 1].forEach(function(i) {
        setTimeout(function() {
          var hub = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });
          hubs.push(hub);
          hub.silent();
          hub.name('hub.' + i);
          hub.link(proxyUrl);
          hub.use(Led);

          hub.listen(0, function(err) {
            if (err) {
              return done(err);
            }

            hub.runtime.pubsub.subscribe('_peer/connect', function() {
              hubsStarted++;
              if (hubsStarted === 2) {
                etcd._trigger('/router/zetta', []);
                done();
              }
            })

          });
        }, 100*i);

      })
    }

  });  

  describe('HTTP API', function() {    

    it('GET /peer-management will return all connected hubs', function(done) {
      request(proxy._server)
        .get('/peer-management')
        .expect(200)
        .expect(getBody(function(res, body) {
          assert(body.class.indexOf('peer-management') > -1);
          assert(body.links.filter(function(l) { return l.rel.indexOf('self') > -1; }).length > 0);
          assert(body.links.filter(function(l) { return l.rel.indexOf('monitor') > -1; }).length > 0);
          assert.equal(body.entities.length, 2);
          body.entities.forEach(function(entity) {
            assert(entity.class.indexOf('peer') > -1);
            assert.equal(entity.actions.length, 2);
            assert(entity.links.filter(function(l) { return l.rel.indexOf('http://rels.zettajs.io/server') > -1; }).length > 0);
            assert(entity.links.filter(function(l) { return l.rel.indexOf('self') > -1; }).length > 0);
            assert(entity.links.filter(function(l) { return l.rel.indexOf('monitor') > -1; }).length > 0);
          });
        }))
        .end(done);
    });


    it('GET /peer-management/hub.0 will return connected hubs', function(done) {
      request(proxy._server)
        .get('/peer-management/hub.0')
        .expect(200)
        .expect(getBody(function(res, body) {
        }))
        .end(done);
    });


  })

});
