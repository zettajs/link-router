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

var State = module.exports =  function(HealthyThreshold, UnhealthyThreshold) {
  this.HealthyThreshold = HealthyThreshold || 2;
  this.UnhealthyThreshold = UnhealthyThreshold || 2;

  this.lastCheck = new Date(0);
  this.lastSeen = new Date(0);
  this.count = 0;
  this.status = 'UNDETERMINED';
};

State.prototype.success = function() {
  this.lastCheck = new Date();
  this.lastSeen = this.lastCheck;

  // Was in failed state
  if (this.count < 0) {
    this.count = 0;
  }

  this.count++;
  if (Math.abs(this.count) >= this.HealthyThreshold || this.status === 'UNDETERMINED') {
    this.status = 'UP';
  }
};

State.prototype.fail = function() {
  this.lastCheck = new Date();

  if (this.count > 0) {
    this.count = 0;
  }

  this.count--;
  if (Math.abs(this.count) >= this.UnhealthyThreshold || this.status === 'UNDETERMINED') {
    this.status = 'DOWN';
  }
};
