FROM node:10.16

ENV HTTP_PORT 8000

# @FIX Debian Jessie / Docker issue with apt.
# See: https://stackoverflow.com/questions/46406847/docker-how-to-add-backports-to-sources-list-via-dockerfile
RUN echo "deb http://archive.debian.org/debian/ jessie main\n" \
  "deb-src http://archive.debian.org/debian/ jessie main\n" \
  "deb http://security.debian.org jessie/updates main\n" \
  "deb-src http://security.debian.org jessie/updates main" > /etc/apt/sources.list

# Update the apt cache
RUN apt-get clean
RUN apt-get update

# Apt-utils needs to be in before installing the rest
RUN apt-get install -y \
  build-essential \
  python \
  curl \
  file \
  zip \
  nginx

# Reconfigure locales
# RUN echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen
# RUN locale-gen

# Add the repo
ADD . / pinion-logger/
WORKDIR /pinion-logger

# Install node_modules
RUN yarn

# Setup a basic nginx config
RUN echo "server {\n" \
  "    listen       80;\n" \
  "    server_name  default_server;\n\n" \
  "    location / {\n" \
  "      proxy_pass http://localhost:$HTTP_PORT;\n" \
  "    }\n" \
  "}" > /etc/nginx/sites-available/default

# Expose the HTTP port
EXPOSE 80

# What's that? A new colony was created...
ENTRYPOINT scripts/start_daemons.sh
