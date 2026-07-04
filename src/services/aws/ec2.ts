/**
 * Minimal EC2 control-plane client (query protocol) — exactly the six actions
 * the app needs, matching the scoped IAM policy in docs/aws-iam-policy.json:
 * RunInstances, StopInstances, StartInstances, DescribeInstances,
 * TerminateInstances, CreateTags.
 *
 * Endpoint is configurable so this is testable against LocalStack (§6a) with
 * dummy credentials before any real AWS account exists (§6b).
 */
import { signQuery, AwsCreds } from './sigv4';

export const EC2_API_VERSION = '2016-11-15';
export const MANAGED_BY_TAG_KEY = 'ManagedBy';
export const MANAGED_BY_TAG_VALUE = 'sprites-rn-manager';

export interface Ec2Client {
  creds: AwsCreds;
  region: string;
  /** Override the endpoint, e.g. http://localhost:4566 for LocalStack. */
  endpoint?: string;
}

function ec2Host(c: Ec2Client): string {
  if (c.endpoint) return new URL(c.endpoint).host;
  return `ec2.${c.region}.amazonaws.com`;
}

function ec2Url(c: Ec2Client): string {
  if (c.endpoint) return c.endpoint.replace(/\/+$/, '') + '/';
  return `https://ec2.${c.region}.amazonaws.com/`;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** First `<tag>…</tag>` text, or undefined. EC2 responses are shallow enough
 * that targeted extraction beats bundling an XML parser into the RN app. */
function extract(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? decodeXml(m[1]) : undefined;
}

function parseEc2Error(xml: string): string | undefined {
  const code = extract(xml, 'Code');
  const message = extract(xml, 'Message');
  if (code || message) return `${code ?? 'Error'}: ${message ?? ''}`.trim();
  return undefined;
}

async function ec2Call(c: Ec2Client, params: Record<string, string>): Promise<string> {
  const body = new URLSearchParams({ Version: EC2_API_VERSION, ...params }).toString();
  const { headers } = signQuery({
    creds: c.creds,
    region: c.region,
    service: 'ec2',
    host: ec2Host(c),
    body,
  });
  const res = await fetch(ec2Url(c), { method: 'POST', headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseEc2Error(text) ?? `EC2 ${params.Action} failed (HTTP ${res.status})`);
  }
  return text;
}

export interface RunInstanceOptions {
  imageId: string;
  instanceType: string;
  /** Base64-encoded cloud-init user_data. */
  userData: string;
  name?: string;
  securityGroupId?: string;
  subnetId?: string;
  keyName?: string;
}

export async function runInstance(
  c: Ec2Client,
  opts: RunInstanceOptions
): Promise<{ instanceId: string }> {
  const params: Record<string, string> = {
    Action: 'RunInstances',
    ImageId: opts.imageId,
    InstanceType: opts.instanceType,
    MinCount: '1',
    MaxCount: '1',
    UserData: opts.userData,
    // Tag at creation so the IAM aws:RequestTag condition is satisfied.
    'TagSpecification.1.ResourceType': 'instance',
    'TagSpecification.1.Tag.1.Key': MANAGED_BY_TAG_KEY,
    'TagSpecification.1.Tag.1.Value': MANAGED_BY_TAG_VALUE,
  };
  if (opts.name) {
    params['TagSpecification.1.Tag.2.Key'] = 'Name';
    params['TagSpecification.1.Tag.2.Value'] = opts.name;
  }
  if (opts.securityGroupId) params['SecurityGroupId.1'] = opts.securityGroupId;
  if (opts.subnetId) params['SubnetId'] = opts.subnetId;
  if (opts.keyName) params['KeyName'] = opts.keyName;

  const xml = await ec2Call(c, params);
  const instanceId = extract(xml, 'instanceId');
  if (!instanceId) throw new Error('RunInstances returned no instanceId');
  return { instanceId };
}

export async function startInstance(c: Ec2Client, instanceId: string): Promise<void> {
  await ec2Call(c, { Action: 'StartInstances', 'InstanceId.1': instanceId });
}

export async function stopInstance(c: Ec2Client, instanceId: string): Promise<void> {
  await ec2Call(c, { Action: 'StopInstances', 'InstanceId.1': instanceId });
}

export async function terminateInstance(c: Ec2Client, instanceId: string): Promise<void> {
  await ec2Call(c, { Action: 'TerminateInstances', 'InstanceId.1': instanceId });
}

export async function createManagedTags(
  c: Ec2Client,
  instanceId: string,
  name?: string
): Promise<void> {
  const params: Record<string, string> = {
    Action: 'CreateTags',
    'ResourceId.1': instanceId,
    'Tag.1.Key': MANAGED_BY_TAG_KEY,
    'Tag.1.Value': MANAGED_BY_TAG_VALUE,
  };
  if (name) {
    params['Tag.2.Key'] = 'Name';
    params['Tag.2.Value'] = name;
  }
  await ec2Call(c, params);
}

export type InstanceLifecycle =
  | 'pending'
  | 'running'
  | 'shutting-down'
  | 'terminated'
  | 'stopping'
  | 'stopped'
  | 'unknown';

export interface InstanceStatus {
  instanceId: string;
  state: InstanceLifecycle;
  publicIp?: string;
  publicDns?: string;
}

export async function describeInstance(c: Ec2Client, instanceId: string): Promise<InstanceStatus> {
  const xml = await ec2Call(c, { Action: 'DescribeInstances', 'InstanceId.1': instanceId });
  // Scope to <instanceState> so a stray <name> elsewhere can't be picked up.
  const stateMatch = xml.match(/<instanceState>[\s\S]*?<name>([^<]+)<\/name>/);
  const state = (stateMatch ? (stateMatch[1] as InstanceLifecycle) : 'unknown');
  const publicIp = extract(xml, 'ipAddress');
  const publicDns = extract(xml, 'dnsName');
  return {
    instanceId,
    state,
    publicIp: publicIp || undefined,
    publicDns: publicDns || undefined,
  };
}
