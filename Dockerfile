FROM  node:0.12
MAINTAINER Matthew Dobson

ADD     . /proxy_server
WORKDIR /proxy_server
RUN     npm install

ENV    PORT 3000
EXPOSE 3000

CMD        ["proxy_server.js"]
ENTRYPOINT ["node"]
