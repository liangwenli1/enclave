FROM python:3.12-alpine
WORKDIR /site
COPY index.html pricing.html download.html docs.html account.html legal.html ./
COPY css ./css
COPY js ./js
EXPOSE 3011
CMD ["python", "-m", "http.server", "3011", "--bind", "0.0.0.0"]
