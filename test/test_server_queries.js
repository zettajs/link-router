// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var assert = require('assert');
var url = require('url');
var request = require('supertest');
var zetta = require('zetta');
var Led = require('zetta-led-mock-driver');
var WebSocket = require('ws');
var StatsClient = require('stats-client');
var redirect = require('zetta-peer-redirect');

var MemoryDeviceRegistry = require('./mocks/memory_device_registry');
var MemoryPeerRegistry = require('./mocks/memory_peer_registry');
var MockEtcd = require('./mocks/mock_etcd');
var MockTenantMgmtApi = require('./mocks/tenant_mgmt_api');
var RouterUpdater = require('./mocks/routing_updater');
var VersionClient = require('../clients/version_client');
var ServiceRegistryClient = require('../clients/service_registry_client');
var RouterClient = require('../clients/router_client');
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

describe('Queries', function() {
  var proxy = null;
  var proxyUrl = null;
  var hubs = [];
  var targets = [];
  var etcd = null;

  beforeEach(function() {
    etcd = new MockEtcd();
  })
  
  beforeEach(function(done) {
    tenantMgmtApi = new MockTenantMgmtApi(etcd);
    tenantMgmtApi.listen(0, done);
  })

  beforeEach(function(done) {
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
      target.use(RouterUpdater('', routerClient, serviceRegistryClient));
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
      proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient, tenantMgmtApi.href());
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
          hub.use(redirect);
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
                setTimeout(done, 10);
              }
            })

          });
        }, 100*i);

      })
    }

  });  

  describe('Cross Server', function() {    
    it('will return all leds from both hubs.', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: '*', ql: 'where type = "led"' } });
      request(proxy._server)
        .get(reqUrl)
        .expect(200)
        .expect(getBody(function(res, body) {
          assert(body.class.indexOf('root') > -1);
          assert(body.class.indexOf('search-results') > -1);
          assert.equal(body.properties.server, '*');
          assert.equal(body.properties.ql, 'where type = "led"');
          assert.equal(body.entities.length, 2);
        }))
        .end(done);
    });

    it('will return no photocells from either hub.', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: '*', ql: 'where type = "photocell"' } });
      request(proxy._server)
        .get(reqUrl)
        .expect(200)
        .expect(getBody(function(res, body) {
          assert(body.class.indexOf('root') > -1);
          assert(body.class.indexOf('search-results') > -1);
          assert.equal(body.properties.server, '*');
          assert.equal(body.properties.ql, 'where type = "photocell"');
          assert.equal(body.entities.length, 0);
        }))
        .end(done);
    });

    it('will have Content-Type and Content-Length in response.', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: '*', ql: 'where type = "photocell"' } });
      request(proxy._server)
        .get(reqUrl)
        .expect('Content-Type', 'application/vnd.siren+json')
        .expect('Content-Length', /[0-9]/)
        .expect(200)
        .end(done);
    });



    it('links on the query response will point to proxy.', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: '*', ql: 'where type = "led"' } });
      request(proxy._server)
        .get(reqUrl)
        .expect(200)
        .expect(getBody(function(res, body) {
          var parsed = url.parse(proxyUrl);
          var test = function(link) {
            assert.equal(url.parse(link.href).host, parsed.host);
          };
          body.links.forEach(test);
          body.entities.forEach(function(e) {
            e.links.forEach(test);
          });
        }))
        .end(done);
    });

    it('it should return no entries with tenant that does not exist.', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: '*', ql: 'where type = "photocell"' } });
      request(proxy._server)
        .get(reqUrl)
        .set('X-Apigee-IoT-Tenant-Id', 'test')
        .expect(200)
        .expect(getBody(function(res, body) {
          assert(body.class.indexOf('root') > -1);
          assert(body.class.indexOf('search-results') > -1);
          assert.equal(body.properties.server, '*');
          assert.equal(body.properties.ql, 'where type = "photocell"');
          assert.equal(body.entities.length, 0);
        }))
        .end(done);
    });

    it('should return query-error for malformed query', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: '*', ql: 'where asd type = "photocell"' } });
      request(proxy._server)
        .get(reqUrl)
        .expect(400)
        .expect(getBody(function(res, body) {
          assert(body.class.indexOf('query-error') > -1);
          assert(body.properties.message);
        }))
        .end(done);
    })

    it('ws connection should return two leds', function(done) {
      var parsed = url.parse(proxyUrl);
      parsed.protocol = 'ws:';
      parsed.pathname = '/events';
      parsed.query = {
        topic: 'query/where type="led"',
        since: new Date().getTime()
      };

      var ws = new WebSocket(url.format(parsed));
      var count = 0;
      ws.on('message', function(data, flags) {
        var json = JSON.parse(data);
        assert.equal(Object.keys(json).length, 4);
        assert(json.class)
        assert(json.properties)
        assert(json.actions)
        assert(json.links)
        count++;
        if (count === 2) {
          done();
        }
      });
    });

    it('second ws connection to query should receive leds', function(done) {
      var startWs = function(next) {
        var parsed = url.parse(proxyUrl);
        parsed.protocol = 'ws:';
        parsed.pathname = '/events';
        parsed.query = {
          topic: 'query/where type="led"',
          since: new Date().getTime()
        };

        var ws = new WebSocket(url.format(parsed));
        var count = 0;
        ws.on('message', function(data, flags) {
          JSON.parse(data);
          count++;
          if (count === 2) {
            next();
          }
        });
        ws.on('error', function(err) {
          console.log(err);
        })
      }

      startWs(function() {
        startWs(function() {
          done();
        })
      });
    })

    it('should return devices from connected peers on out of version targets', function(done) {
      etcd.set('/zetta/version', '{"version":"2"}');
      etcd._trigger('/zetta/version', '{"version":"2"}');

      var reqUrl = url.format({ pathname: '/', query: { server: '*', ql: 'where type = "led"' } });
      request(proxy._server)
        .get(reqUrl)
        .expect(200)
        .expect(getBody(function(res, body) {
          assert(body.class.indexOf('root') > -1);
          assert(body.class.indexOf('search-results') > -1);
          assert.equal(body.properties.server, '*');
          assert.equal(body.properties.ql, 'where type = "led"');
          assert.equal(body.entities.length, 2);
        }))
        .end(done);
    })
  })
  
  describe('Single Server', function() {
    it('will return one led from hub.1.', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: 'hub.1', ql: 'where type = "led"' } });
      request(proxy._server)
        .get(reqUrl)
        .expect(200)
        .expect(getBody(function(res, body) {
          assert(body.class.indexOf('root') > -1);
          assert(body.class.indexOf('search-results') > -1);
          assert.equal(body.properties.server, 'hub.1');
          assert.equal(body.properties.ql, 'where type = "led"');
          assert.equal(body.entities.length, 1);
        }))
        .end(done);
    });

    it('will return no photocells from hub.1.', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: 'hub.1', ql: 'where type = "photocell"' } });
      request(proxy._server)
        .get(reqUrl)
        .expect(200)
        .expect(getBody(function(res, body) {
          assert(body.class.indexOf('root') > -1);
          assert(body.class.indexOf('search-results') > -1);
          assert.equal(body.properties.server, 'hub.1');
          assert.equal(body.properties.ql, 'where type = "photocell"');
          assert.equal(body.entities.length, 0);
        }))
        .end(done);
    });


    it('links on the query response will point to proxy.', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: 'hub.1', ql: 'where type = "led"' } });
      request(proxy._server)
        .get(reqUrl)
        .expect(200)
        .expect(getBody(function(res, body) {
          var parsed = url.parse(proxyUrl);
          var test = function(link) {
            assert.equal(url.parse(link.href).host, parsed.host);
          };
          body.links.forEach(test);
          body.entities.forEach(function(e) {
            e.links.forEach(test);
          });
        }))
        .end(done);
    });

    it('it should return no entries with tenant that does not exist.', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: 'hub.1', ql: 'where type = "led"' } });
      request(proxy._server)
        .get(reqUrl)
        .set('X-Apigee-IoT-Tenant-Id', 'test')
        .expect(200)
        .expect(getBody(function(res, body) {
          assert(body.class.indexOf('root') > -1);
          assert(body.class.indexOf('search-results') > -1);
          assert.equal(body.properties.server, 'hub.1');
          assert.equal(body.properties.ql, 'where type = "led"');
          assert.equal(body.entities.length, 0);
        }))
        .end(done);
    });

    it('it should return no entries when hub does not exist.', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: 'hub.2131', ql: 'where type = "led"' } });
      request(proxy._server)
        .get(reqUrl)
        .expect(200)
        .expect(getBody(function(res, body) {
          assert(body.class.indexOf('root') > -1);
          assert(body.class.indexOf('search-results') > -1);
          assert.equal(body.properties.server, 'hub.2131');
          assert.equal(body.properties.ql, 'where type = "led"');
          assert.equal(body.entities.length, 0);
        }))
        .end(done);
    });

    it('should return query-error for malformed query', function(done) {
      var reqUrl = url.format({ pathname: '/', query: { server: 'hub.1', ql: 'where asd type = "photocell"' } });
      request(proxy._server)
        .get(reqUrl)
        .expect(400)
        .expect(getBody(function(res, body) {
          assert(body.class.indexOf('query-error') > -1);
          assert(body.properties.message);
        }))
        .end(done);
    })


  })

});
