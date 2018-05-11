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

var async = require('async');
var TargetState = require('./target_state');
var targetCheck = require('./target_check');

var Defaults = {
  Interval: 30000,
  Timeout: 10000,
  HealthyThreshold: 2,
  UnhealthyThreshold: 5,
  MaxParallel: 5,
  AssumeHealthy: false
};

var MonitorService = module.exports = function(serviceRegistryClient, opts) {
  var self = this;

  if (!opts) {
    opts = {};
  }

  if (!serviceRegistryClient) {
    throw new Error('ServiceRegistryClient must be supplied');
  }
  this.serviceRegistryClient = serviceRegistryClient;

  Object.keys(Defaults).forEach(function(k) {
    self[k] = Defaults[k];
    if (opts.hasOwnProperty(k)) {
      self[k] = opts[k];
    }
  });

  if (!this.log) {
    this.log = console;
  }

  this.state = {}; // { <targetUrl>: TargetState }
  this.disabled = (opts.disabled === true);
  // If disabled don't do anything
  if (this.disabled) {
    return;
  } else {
    this.start();
  }
};

MonitorService.prototype.start = function() {
  clearInterval(this._intervalTimer);
  this._intervalTimer = setInterval(this._run.bind(this), this.Interval);
  this._run();
};

MonitorService.prototype.stop = function() {
  clearInterval(this._intervalTimer);
};

MonitorService.prototype.status = function(targetUrl) {
  if (this.disabled) {
    return true;
  }

  if (!this.state.hasOwnProperty(targetUrl)) {
    return (!!this.AssumeHealthy);
  } else {
    if (this.state[targetUrl].status === 'UP') {
      return true;
    } else if (this.state[targetUrl].status === 'DOWN') {
      return false;
    } else {
      return (!!this.AssumeHealthy);
    }
  }
};

MonitorService.prototype._run = function() {
  var self = this;
  // gather hosts
  // foreach host check and update state

  this.gatherHosts(function(err, hosts) {
    if (err) {
      self.log.error('Monitor: Failed to gather targets. ' + err);
      return;
    }

    // check state for hosts that are not in etcd any more
    Object.keys(self.state).forEach(function(targetUrl) {
      var found = hosts.some(function(target) {
        return (target.url === targetUrl);
      });

      if (found) {
        return;
      }
      
      // leave in state until it's marked as DOWN
      if (self.status(targetUrl) === 'UP') {
        // if host is still up mark it as a failure until till it's offline then remove it.
        self.state[targetUrl].fail();
      } else {
        delete self.state[targetUrl];
      }
    });

    async.eachLimit(hosts, self.MaxParallel, self._updateHost.bind(self), function(err) {});
  });
};

// check and update host state
MonitorService.prototype._updateHost = function(target, callback) {
  var self = this;

  if (!this.state.hasOwnProperty(target.url)) {
    this.state[target.url] = new TargetState(this.HealthyThreshold, this.UnHealthyThreshold);
  }

  var state = this.state[target.url];
  var opts = {
    Timeout: this.Timeout
  };

  targetCheck(opts, target, function(result, err) {
    if (result) {
      state.success();
    } else {
      state.fail();
      self.log.error('Monitor Checkking target ' + target.url + ' FAILED new status ' + self.status(target.url));
    }

    callback();
  });
};

MonitorService.prototype.gatherHosts = function(callback) {
  this.serviceRegistryClient.findAll(callback);
};

MonitorService.Defaults = Defaults;
