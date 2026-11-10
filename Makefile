.PHONY: run pack test docker-build docker-run

run:
	python3 main.py

pack:
	python3 main.py --pack

test:
	python3 tests/smoke.py

docker-build:
	docker build -t cosmomarket .

docker-run:
	docker run --rm -p 127.0.0.1:8000:8000 -v cosmomarket-data:/app/data cosmomarket
