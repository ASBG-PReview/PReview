{{- define "preview-api.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "preview-api.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "preview-api.serviceName" -}}
{{- if regexMatch "^[a-z][a-z0-9-]*$" .Release.Name -}}
{{- include "preview-api.fullname" . -}}
{{- else -}}
{{- /* Service names must also work on clusters using RFC 1035. Hash before normalizing or truncating. */ -}}
{{- $prefix := replace "." "-" .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- printf "p-%s-%s" $prefix (printf "%s-%s" .Release.Name .Chart.Name | sha256sum | trunc 20) -}}
{{- end -}}
{{- end -}}

{{- define "preview-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "preview-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}

{{- define "preview-api.basePath" -}}
{{- $path := .Values.basePath | default "" -}}
{{- if and $path (not (regexMatch "^(/[A-Za-z0-9_-]+)+$" $path)) -}}
{{- fail "basePath must be empty or an absolute path without trailing slash" -}}
{{- end -}}
{{- $path -}}
{{- end -}}
