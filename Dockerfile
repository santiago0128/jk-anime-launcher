# El bot corre a demanda, no como servicio. Va en contenedor para traerse su
# propio Node 20 sin tocar el del servidor, que tiene otras aplicaciones encima.
FROM node:20-alpine

WORKDIR /bot

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY *.js ./

# Aquí se monta el .env de la aplicación, de donde salen los datos de conexión.
ENV STREAMFLIX_ROOT=/streamflix
# En un servidor no hay navegador que abrir.
ENV JK_NO_BROWSER=1

ENTRYPOINT ["node"]
CMD ["import_series_to_streamflix.js"]
