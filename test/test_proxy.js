var assert = require('assert');
var request = require('supertest');
var Proxy = require('../proxy');
var MockEtcd = require('./mocks/mock_etcd');
var VersionClient = require('../version_client');
var ServiceRegistryClient = require('../service_registry_client');
var RouterClient = require('../router_client');

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

describe('Proxy', function() {
  var proxy = null;
  var etcd = null;

  beforeEach(function(done) {
    etcd = new MockEtcd();
    etcd.set('/zetta/version', JSON.stringify({ version: '1'}));
    etcd.mkdir('/services/zetta');
    etcd.mkdir('/router/zetta');
    etcd.keyValuePairs['/services/zetta'] = [];
    etcd.keyValuePairs['/router/zetta'] = [];
    var versionClient = new VersionClient({ client: etcd });
    var serviceRegistryClient = new ServiceRegistryClient({ client: etcd });
    var routerClient = new RouterClient({ client: etcd });
    proxy = new Proxy(serviceRegistryClient, routerClient, versionClient);
    proxy.listen(0);
    done();
  });

  afterEach(function(done) {
    proxy._server.close();  
    done();
  });

  describe('request routing', function() {
    it('will properly route to the root request', function(done) {
      request(proxy._server)
        .get('/')
        .expect('Access-Control-Allow-Origin', '*', done);
    });

    it('will have servers within the router in the API response', function(done) {
      etcd.set('/router/zetta/default/foo', '{"url":"http://example.com/", "name": "foo", "tenantId": "default"}');
      etcd._trigger('/router/zetta/default', []);
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          assert.equal(body.links.length, 2);
          var peerLink = body.links[1];
          assert.equal(peerLink.title, "foo");
        }))
        .end(done);
    });

    it('will have a list of links.', function(done) {
       request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          assert.ok(Array.isArray(body.links));  
        }))
        .end(done);
    });

    it('will have a class of root', function(done) {
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          assert.equal(body.class[0], 'root');  
        }))
        .end(done);  
    });

    it('will only have a self link', function(done) {
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          var selfLink = body.links[0];
          assert.equal(body.links.length, 1);
          assert.notEqual(selfLink.rel.indexOf('self'), -1);
        }))
        .end(done);  
    });

    
  });  
  describe('Proxy updates from etcd', function() {
    it('will update the version from an etcd watcher', function() {
      etcd.set('/zetta/version', '{"version":"1"}');
      etcd.set('/zetta/version', '{"version":"2"}');
      etcd._trigger('/zetta/version', '{"version":"2"}');
      assert.equal(proxy._currentVersion, "2");
    });

    it('will update the current routes from an etcd watcher', function() {
      etcd.set('/router/zetta/default', '{"url":"http://example.com/", "tenantId": "default"}');
      etcd.set('/router/zetta/', '{"url":"http://example.com/", "tenantId": "default"}');
      etcd._trigger('/router/zetta', []);
      var routerKeys = Object.keys(proxy._router);
      assert.equal(routerKeys.length, 1);      
    });

    it('will update the current targets from an etcd watcher', function() {
      etcd.set('/services/zetta/foo', '{"url":"http://example.com/", "tenantId": "default"}');
      etcd._trigger('/services/zetta', []);
      assert.equal(Object.keys(proxy._servers).length, 1);
    });
  });
    
});
