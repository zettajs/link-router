var assert = require('assert');
var url = require('url');
var http = require('http');
var request = require('supertest');
var zetta = require('zetta');
var Led = require('zetta-led-mock-driver');
var WebSocket = require('ws');
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

    // clear existing hubs
    hubs = [];
    targets = [];

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

  afterEach(function(done) {
    proxy._server.close();  
    done();
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


    it('DELETE /peer-management/hub.0 will disconnect peer', function(done) {
      var delLink = null;

      request(proxy._server)
        .get('/peer-management/hub.0')
        .expect(200)
        .expect(getBody(function(res, body) {
          delLink = body.actions.filter(function(a) { return a.name === 'disconnect'; })[0].href;
        }))
        .end(function(err) {
          if (err) done(err);
          hubs[0].pubsub.subscribe('_peer/disconnect', function(topic, data) {
            if (data.peer.url.indexOf('hub.0') > -1) {
              done();
            }
          });

          var parsed = url.parse(delLink);
          var opts = { method: 'DELETE',
                       path: parsed.path,
                       hostname: parsed.hostname,
                       port: parsed.port
                     };

          http.request(opts, function(res) {
            assert.equal(res.statusCode, 200);
          }).end();
        });

    });


    it('PUT /peer-management/hub.0 will update peer for reconnect', function(done) {
      var delLink = null;

      request(proxy._server)
        .get('/peer-management/hub.0')
        .expect(200)
        .expect(getBody(function(res, body) {
          delLink = body.actions.filter(function(a) { return a.name === 'disconnect'; })[0].href;
        }))
        .end(function(err) {
          if (err) return done(err);

          var connectedAgain = false;
          hubs[0].runtime.pubsub.subscribe('_peer/disconnect', function(topic, data) {
            hubs[0].pubsub.subscribe('_peer/connect', function(topic, data) {
              // sometimes called twice because of 409 conflict it gets when trying to immediately reconnect
              // before etcd is updated.
              if (!connectedAgain) {
                connectedAgain = true;
                done();
              }
            });
          });

          var body = 'url=' + encodeURIComponent(proxyUrl);
          var parsed = url.parse(delLink);
          var opts = { method: 'PUT',
                       path: parsed.path,
                       hostname: parsed.hostname,
                       port: parsed.port,
                       headers: {
                         'Content-Type': 'application/x-www-form-urlencoded',
                         'Content-Length': body.length
                       }
                     };

          http.request(opts, function(res) {
            assert.equal(res.statusCode, 200);
          }).end(body);

        });

    });

  })

  describe('WS API', function() {
    it('should receive disconnect message when peer disconnects', function(done) {
      var ws = new WebSocket(proxyUrl + '/peer-management');
      ws.on('open', function() {
        setTimeout(function() {
          hubs[0]._peerClients[0].close();
        }, 200);
      });
      ws.on('message', function(msg) {
        var json = JSON.parse(msg);
        assert.equal(Object.keys(json).length, 3);
        assert(json.timestamp);
        if (json.topic === '_peer/disconnect') {
          assert.equal(json.data.id, 'hub.0');
          assert(json.data.connectionId);
          done();
        }
      });
    })

    it('should receive a 404 if not the right url', function(done) {
      var ws = new WebSocket(proxyUrl + '/peer-management/12');
      ws.on('error', function(err) {
        assert.equal(err.message, 'unexpected server response (404)');
        done();
      })
    })

  })
  
});
