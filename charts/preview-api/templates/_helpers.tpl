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
