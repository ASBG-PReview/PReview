NAMESPACE ?= preview-local
RELEASE ?= preview
IMAGE_REPOSITORY ?= preview-api
IMAGE_TAG ?= 0.0.1
PR_NUMBER ?= local
COMMIT_SHA ?= unknown
LOCAL_PORT ?= 18080
CHART := charts/preview-api
LOCAL_VALUES := $(CHART)/values-local.yaml
KUBECTL := kubectl --context minikube
HELM := helm --kube-context minikube

.PHONY: build load lint deploy test clean

build:
	docker build -t $(IMAGE_REPOSITORY):$(IMAGE_TAG) preview-api

load:
	minikube image load $(IMAGE_REPOSITORY):$(IMAGE_TAG)

lint:
	helm lint $(CHART) -f $(LOCAL_VALUES) \
		--set-string image.repository=$(IMAGE_REPOSITORY) --set-string image.tag=$(IMAGE_TAG)

deploy:
	@$(KUBECTL) get namespace $(NAMESPACE) >/dev/null 2>&1 || \
		$(KUBECTL) create namespace $(NAMESPACE)
	$(KUBECTL) apply -n $(NAMESPACE) -f quota.yaml
	$(HELM) upgrade --install $(RELEASE) $(CHART) --namespace $(NAMESPACE) \
		-f $(LOCAL_VALUES) --set-string image.repository=$(IMAGE_REPOSITORY) \
		--set-string image.tag=$(IMAGE_TAG) --set-string preview.prNumber=$(PR_NUMBER) \
		--set-string preview.commitSha=$(COMMIT_SHA)
	$(KUBECTL) rollout status deployment/$(RELEASE)-preview-api -n $(NAMESPACE) --timeout=180s

test:
	@set -eu; \
	PORT=$(LOCAL_PORT) python3 -c 'import socket, os; s=socket.socket(); s.bind(("127.0.0.1", int(os.environ["PORT"]))); s.close()' 2>/dev/null || \
		{ echo '로컬 테스트 포트를 사용할 수 없습니다: $(LOCAL_PORT)'; exit 1; }; \
	$(KUBECTL) port-forward -n $(NAMESPACE) service/$(RELEASE)-preview-api $(LOCAL_PORT):8080 >/dev/null 2>&1 & \
	pid=$$!; trap 'kill $$pid 2>/dev/null || true' EXIT INT TERM; \
	i=0; until curl --fail --silent http://127.0.0.1:$(LOCAL_PORT)/health >/dev/null; do \
		if ! kill -0 $$pid 2>/dev/null || [ $$i -ge 30 ]; then echo '포트 연결 실패'; exit 1; fi; \
		i=$$((i + 1)); sleep 1; \
	done; \
	PR_NUMBER='$(PR_NUMBER)' COMMIT_SHA='$(COMMIT_SHA)' NAMESPACE='$(NAMESPACE)' \
	EXPECTED_VERSION="$$(cat preview-api/src/main/version.txt)" LOCAL_PORT='$(LOCAL_PORT)' \
	python3 -c 'import json, os, urllib.request; base="http://127.0.0.1:"+os.environ["LOCAL_PORT"]; get=lambda path: json.load(urllib.request.urlopen(base+path)); health=get("/health"); env=get("/environment"); version=get("/version"); expected={"prNumber":os.environ["PR_NUMBER"],"commitSha":os.environ["COMMIT_SHA"],"namespace":os.environ["NAMESPACE"]}; assert health.get("status")=="ok", health; assert env==expected, (env, expected); assert version.get("version")==os.environ["EXPECTED_VERSION"], version; print("정상 응답:", health, env, version)'

clean:
	$(HELM) uninstall $(RELEASE) -n $(NAMESPACE)
