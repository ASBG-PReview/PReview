NAMESPACE ?= preview-local
RELEASE ?= preview
MINIKUBE_PROFILE ?= minikube
IMAGE_REPOSITORY ?= preview-api
IMAGE_TAG ?= 0.0.1
PR_NUMBER ?= local
COMMIT_SHA ?= unknown
LOCAL_PORT ?= 18080
PYTHON ?= python3
export NAMESPACE RELEASE MINIKUBE_PROFILE IMAGE_REPOSITORY IMAGE_TAG PR_NUMBER COMMIT_SHA LOCAL_PORT

.NOTPARALLEL:
.PHONY: build load lint deploy test clean

build:
	docker build -t "$(IMAGE_REPOSITORY):$(IMAGE_TAG)" preview-api

deploy load test:
	$(PYTHON) scripts/local_preview.py $@

lint:
	helm lint charts/preview-api -f charts/preview-api/values-local.yaml \
		--set-string "image.repository=$(IMAGE_REPOSITORY)" --set-string "image.tag=$(IMAGE_TAG)"

clean:
	helm --kube-context "$(MINIKUBE_PROFILE)" uninstall "$(RELEASE)" -n "$(NAMESPACE)"
