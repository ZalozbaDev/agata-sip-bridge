# build containers

docker build -f asterisk/Dockerfile -t asterisk --progress=plain asterisk/

docker build -f node/Dockerfile -t agata-sip-client --progress=plain node/
