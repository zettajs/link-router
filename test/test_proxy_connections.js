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

var http = require('http');
var assert = require('assert');
var request = require('supertest');
var zetta = require('zetta');
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

describe('Proxy Connection', function() {
  var hub = null;
  var proxy = null;
  var etcd = null;
  var target = null;
  var proxyUrl = null;
  var newTarget = null;
  var serviceRegistryClient = null;
  var routerClient = null;

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
    serviceRegistryClient = new ServiceRegistryClient({ client: etcd });
    routerClient = new RouterClient({ client: etcd });

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
    target.use(RouterUpdater('', routerClient, serviceRegistryClient));

    hub.name('hub.1');
    hub.use(redirect);

    target.listen(0, function(err) {
      if(err) {
        return done(err);
      }

      var cloud = 'http://localhost:' + target.httpServer.server.address().port;
      serviceRegistryClient.add('cloud-target', cloud, '1');
      var statsClient = new StatsClient('localhost:8125');
      proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient, tenantMgmtApi.href()); 
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
    newTarget.use(RouterUpdater('', routerClient, serviceRegistryClient));
    newTarget.silent();


    newTarget.listen(0, function(err) {
      if(err) {
        return done(err);
      }
      
      var cloud = 'http://localhost:' + newTarget.httpServer.server.address().port;
      serviceRegistryClient.add('cloud-target', cloud, '2');
      etcd.set('/zetta/version', '{"version":"2"}');
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

  it('will allocate 2 targets per tenant', function(done) {
    var target2 = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });
    target2.silent();
    target2.use(redirect);
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
