{{- define "preview-demo.fullname" -}}
{{- printf "preview-demo-pr-%s" (toString .Values.prNumber) -}}
{{- end -}}
{{- define "preview-demo.namespace" -}}
{{- default (printf "preview-pr-%s" (toString .Values.prNumber)) .Values.namespace -}}
{{- end -}}
{{- define "preview-demo.host" -}}
{{- default (printf "pr-%s.preview.example.com" (toString .Values.prNumber)) .Values.ingress.host -}}
{{- end -}}
{{- define "preview-demo.selectorLabels" -}}
app.kubernetes.io/name: preview-demo
app.kubernetes.io/instance: {{ .Release.Name | quote }}
preview.demo/pr-number: {{ .Values.prNumber | quote }}
{{- end -}}
{{- define "preview-demo.labels" -}}
{{ include "preview-demo.selectorLabels" . }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end -}}
