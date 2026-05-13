all: clean lint fmt test coverage

# Ensure that all uv commands don't automatically update the lock file. If UV_FROZEN=1 (from the environment)
# then UV_LOCKED should _not_ be set, but otherwise it needs to be set to ensure the lock-file is only ever
# deliberately updated.
ifneq ($(UV_FROZEN),1)
export UV_LOCKED := 1
endif

# Ensure that build-system requires are hash-verified when building.
export UV_BUILD_CONSTRAINT := .build-constraints.txt

UV_RUN := uv run --exact

clean:
	rm -fr .venv htmlcov .pytest_cache .ruff_cache .coverage coverage.xml test-results.xml
	find . -name '__pycache__' -print0 | xargs -0 rm -fr

dev:
	uv sync

lint:
	$(UV_RUN) black --check src/ tests/
	$(UV_RUN) ruff check src/ tests/

fmt:
	$(UV_RUN) black src/ tests/
	$(UV_RUN) ruff check src/ tests/ --fix

test:
	$(UV_RUN) pytest tests/ --cov=src --cov-branch --cov-report=xml

coverage:
	$(UV_RUN) pytest tests/ --cov=src --cov-branch --cov-report=html
	open htmlcov/index.html

build:
	uv build --require-hashes --build-constraints=.build-constraints.txt

lock-dependencies: UV_LOCKED := 0
lock-dependencies:
	uv lock
	printf 'setuptools>=61.0\nwheel\n' | uv pip compile --generate-hashes --universal --no-header --quiet - > .build-constraints.txt

.DEFAULT: all
.PHONY: all clean dev lint fmt test coverage build lock-dependencies
