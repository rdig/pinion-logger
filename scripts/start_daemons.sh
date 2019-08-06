#!/bin/bash

nginx -g "daemon off;" &

yarn start:prod
