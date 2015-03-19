#!/bin/sh

docker rm zetta-target
docker rmi zetta-target

docker build -t mdobson/zetta-cloud-proxy .

