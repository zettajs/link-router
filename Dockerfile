FROM       mdobson/node-zetta-docker
MAINTAINER Matthew Dobson <mdobson@apigee.com>

ADD     . /proxy_server
WORKDIR /proxy_server
RUN     npm install

ENV    PORT 3000
EXPOSE 3000

CMD        ["proxy_server.js"]
ENTRYPOINT ["node"]
