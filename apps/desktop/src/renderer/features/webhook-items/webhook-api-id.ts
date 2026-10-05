/** Whether an `apiId` names a project's webhook collection (`webhooks:<projectId>`) rather than a real REST API. */
export function isWebhookApiId(apiId: string | undefined): boolean {
  return apiId?.startsWith('webhooks:') === true;
}
