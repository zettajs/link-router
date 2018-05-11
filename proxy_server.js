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

var Proxy = require('./proxy');
var RouterClient = require('./router_client');
var ServiceRegistryClient = require('./service_registry_client');
var VersionClient = require('./version_client');
var StatsClient = require('stats-client');
var MonitorService = require('./monitor/service');

var numCPUs = require('os').cpus().length;
const cluster = require('cluster');

if (cluster.isMaster) {
  // Fork workers.
  for (var i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', function(worker, code, signal) {
    console.log('worker ${worker.process.pid} died');
  });
} else {

  var port = process.env.PORT || 4001;

  var opts = {
    host: process.env.COREOS_PRIVATE_IPV4
  };

  // allow a list of peers to be passed, overides COREOS_PRIVATE_IPV4
  if (process.env.ETCD_PEER_HOSTS) {
    opts.host = process.env.ETCD_PEER_HOSTS.split(',');
  }

  var usingTelegrafFormat = !!(process.env.INFLUXDB_HOST);
  if (usingTelegrafFormat) {
    console.log('Using telgraf format.');
  }

  var serviceRegistryClient = new ServiceRegistryClient(opts);
  var routerClient = new RouterClient(opts);
  var versionClient = new VersionClient(opts);
  var statsdHost = process.env.COREOS_PRIVATE_IPV4 || 'localhost';
  var statsClient = new StatsClient(statsdHost + ':8125', { }, { telegraf: usingTelegrafFormat });
  var targetMonitor = new MonitorService(serviceRegistryClient, { 
    disabled: (process.env.DISABLE_TARGET_MONITOR) ? true : false
  });

  var proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient, targetMonitor);
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

}

