{{- define "preview-api.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "preview-api.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "preview-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "preview-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "preview-api.basePath" -}}
{{- $path := .Values.basePath | default "" -}}
{{- if and $path (not (regexMatch "^(/[A-Za-z0-9_-]+)+$" $path)) -}}
{{- fail "basePath must be empty or an absolute path without trailing slash" -}}
{{- end -}}
{{- $path -}}
{{- end -}}
