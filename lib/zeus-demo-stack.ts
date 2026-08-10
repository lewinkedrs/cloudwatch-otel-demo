import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';

export class ZeusDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('auto-delete', 'no');

    // =============================================================
    // VPC - 2 AZs with public and private subnets for EKS cluster
    // =============================================================
    const vpc = new ec2.Vpc(this, 'ZeusVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // =============================================================
    // EKS Cluster - Kubernetes 1.31 with kubectl v31 layer
    // =============================================================
    const cluster = new eks.Cluster(this, 'ZeusCluster', {
      clusterName: 'zeus-otel-demo',
      version: eks.KubernetesVersion.V1_31,
      kubectlLayer: new KubectlV31Layer(this, 'KubectlLayer'),
      defaultCapacity: 0, // We'll create a managed node group separately
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
    });

    // =============================================================
    // Managed Node Group - 4x m5.xlarge with AL2023
    // =============================================================
    // Launch template so nodes boot with IMDSv2 hop limit = 2. A pod is one extra
    // network hop from IMDS (169.254.169.254); the EC2 default hop limit of 1
    // blocks pods, so workloads using the node instance role (ADOT collector,
    // CloudWatch agent, Strands -> Bedrock) can't obtain credentials. Baking it
    // here makes the stack reproducible from scratch with no manual post-deploy
    // `modify-instance-metadata-options` step.
    //
    // Constraints when a managed node group uses a launch template: the root
    // volume and metadata options live in the LT, so `diskSize` is removed from
    // the node group below. We deliberately do NOT set an AMI ID or instance type
    // in the LT, so EKS still injects the EKS-optimized AL2023 AMI (per amiType)
    // and its bootstrap user data.
    const nodeLaunchTemplate = new ec2.CfnLaunchTemplate(this, 'ZeusNodeLaunchTemplate', {
      launchTemplateData: {
        metadataOptions: {
          httpEndpoint: 'enabled',
          httpTokens: 'required',          // enforce IMDSv2
          httpPutResponseHopLimit: 2,      // allow pods to reach IMDS
        },
        blockDeviceMappings: [
          {
            deviceName: '/dev/xvda',        // AL2023 x86 root device
            ebs: {
              volumeSize: 80,
              volumeType: 'gp3',
              deleteOnTermination: true,
              encrypted: true,
            },
          },
        ],
      },
    });

    const nodeGroup = cluster.addNodegroupCapacity('ZeusNodeGroup', {
      instanceTypes: [new ec2.InstanceType('m5.xlarge')],
      // 2 nodes fit the demo comfortably: total pod requests ~5 vCPU / ~10.5 GiB
      // vs ~7.8 vCPU / ~29 GiB allocatable on 2x m5.xlarge (~57% CPU / ~34% mem,
      // ~28 pods/node vs the ~58 cap). Trade-offs (acceptable for a demo): tighter
      // CPU burst headroom under the load-generator, and no single-node-loss
      // tolerance (no cluster autoscaler installed). Raise desiredSize to 3 for
      // margin, or scale up manually up to maxSize.
      minSize: 2,
      maxSize: 4,
      desiredSize: 2,
      amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      capacityType: eks.CapacityType.ON_DEMAND,
      // Root volume + IMDS hop limit are set via the launch template above
      // (diskSize cannot be combined with a launch template).
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      launchTemplateSpec: {
        id: nodeLaunchTemplate.ref,
        version: nodeLaunchTemplate.attrLatestVersionNumber,
      },
    });

    // =============================================================
    // Node Group IAM Policies
    // Instead of IRSA per-service-account, attach all needed policies
    // to the node group role. All pods inherit these permissions via IMDS.
    // =============================================================
    nodeGroup.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
    );
    nodeGroup.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXrayWriteOnlyAccess'),
    );
    // Add Bedrock access for strands agent. Cross-region inference profiles
    // (e.g. us.anthropic.claude-sonnet-4-5-*) require permission on BOTH the
    // inference-profile resource and the underlying foundation models.
    nodeGroup.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
      ],
    }));

    // =============================================================
    // CloudWatch Observability EKS Addon
    // Enables Enhanced Container Insights, container logs, and OTel collection
    // Configured with environment=olympus resource attribute
    // =============================================================
    const addonConfiguration = {
      otelContainerInsights: {
        enabled: true,
      },
      containerLogs: {
        enabled: true,
      },
    };

    // NOTE: serviceAccountRoleArn is intentionally omitted. This cluster has no
    // OIDC/IRSA provider (see the "No IRSA" architecture decision), so annotating
    // the agent's service account for IRSA makes the CloudWatch agent attempt
    // AssumeRoleWithWebIdentity and crash-loop with "InvalidIdentityToken".
    // Without it, the agent falls back to the node instance role via IMDS
    // (hop limit 2), which carries CloudWatchAgentServerPolicy.
    const cwAddon = new eks.CfnAddon(this, 'CloudWatchObservabilityAddon', {
      addonName: 'amazon-cloudwatch-observability',
      clusterName: cluster.clusterName,
      configurationValues: JSON.stringify(addonConfiguration),
      resolveConflicts: 'OVERWRITE',
    });

    // =============================================================
    // Namespaces for OTel Demo workloads
    // =============================================================
    const region = cdk.Stack.of(this).region;

    const namespaces = cluster.addManifest('OtelDemoNamespaces',
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: 'otel-demo' },
      },
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: 'claude-code' },
      },
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: 'agent-observability' },
      },
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: 'prom-app-demo' },
      },
    );

    // =============================================================
    // ADOT Collector - ConfigMap, Deployment, and Service
    // =============================================================
    const adotCollectorConfig = `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
processors:
  batch:
    timeout: 10s
    send_batch_size: 512
  resource:
    attributes:
      - key: deployment.environment
        value: olympus
        action: upsert
      - key: environment
        value: olympus
        action: upsert
exporters:
  otlphttp/traces:
    endpoint: https://xray.${region}.amazonaws.com
    auth:
      authenticator: sigv4auth/traces
  otlphttp/metrics:
    endpoint: https://monitoring.${region}.amazonaws.com
    auth:
      authenticator: sigv4auth/metrics
  otlphttp/logs:
    endpoint: https://logs.${region}.amazonaws.com
    auth:
      authenticator: sigv4auth/logs
extensions:
  sigv4auth/traces:
    region: ${region}
    service: xray
  sigv4auth/metrics:
    region: ${region}
    service: monitoring
  sigv4auth/logs:
    region: ${region}
    service: logs
service:
  extensions: [sigv4auth/traces, sigv4auth/metrics, sigv4auth/logs]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [resource, batch]
      exporters: [otlphttp/traces]
    metrics:
      receivers: [otlp]
      processors: [resource, batch]
      exporters: [otlphttp/metrics]
    logs:
      receivers: [otlp]
      processors: [resource, batch]
      exporters: [otlphttp/logs]
`;

    const adotCollectorManifest = cluster.addManifest('AdotCollectorDeployment',
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: 'adot-collector-config',
          namespace: 'otel-demo',
        },
        data: {
          'collector-config.yaml': adotCollectorConfig,
        },
      },
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'adot-collector',
          namespace: 'otel-demo',
        },
        spec: {
          replicas: 1,
          selector: {
            matchLabels: { app: 'adot-collector' },
          },
          template: {
            metadata: {
              labels: { app: 'adot-collector' },
            },
            spec: {
              containers: [
                {
                  name: 'adot-collector',
                  image: 'public.ecr.aws/aws-observability/aws-otel-collector:v0.41.2',
                  args: ['--config=/etc/otel/collector-config.yaml'],
                  ports: [
                    { containerPort: 4317, name: 'otlp-grpc' },
                    { containerPort: 4318, name: 'otlp-http' },
                  ],
                  resources: {
                    requests: {
                      cpu: '500m',
                      memory: '1Gi',
                    },
                    limits: {
                      memory: '2Gi',
                    },
                  },
                  volumeMounts: [
                    {
                      name: 'config-vol',
                      mountPath: '/etc/otel',
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: 'config-vol',
                  configMap: {
                    name: 'adot-collector-config',
                  },
                },
              ],
            },
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: 'adot-collector',
          namespace: 'otel-demo',
        },
        spec: {
          selector: { app: 'adot-collector' },
          ports: [
            { name: 'otlp-grpc', port: 4317, targetPort: 4317 },
            { name: 'otlp-http', port: 4318, targetPort: 4318 },
          ],
        },
      },
    );
    adotCollectorManifest.node.addDependency(namespaces);

    // =============================================================
    // OTel Demo Helm Chart
    // Deploys the OpenTelemetry demo application suite
    // =============================================================
    const otelDemoChart = cluster.addHelmChart('OtelDemoChart', {
      repository: 'https://open-telemetry.github.io/opentelemetry-helm-charts',
      chart: 'opentelemetry-demo',
      namespace: 'otel-demo',
      createNamespace: false,
      wait: false,
      values: {
        'opentelemetry-collector': {
          enabled: false,
        },
        default: {
          env: [
            {
              // Restore the upstream chart's OTEL_SERVICE_NAME (dropped when we
              // overrode default.env). Without it, services that rely on this env
              // (checkout, shipping, load-generator, frontend-proxy, ...) emit
              // spans as unknown_service:<runtime>, so they show up unnamed in
              // Application Signals and the trace map. Derive it per-pod from the
              // component label, exactly as the upstream chart does.
              name: 'OTEL_SERVICE_NAME',
              valueFrom: {
                fieldRef: {
                  apiVersion: 'v1',
                  fieldPath: "metadata.labels['app.kubernetes.io/component']",
                },
              },
            },
            {
              // The demo chart's per-component templates set
              // OTEL_EXPORTER_OTLP_ENDPOINT=http://$(OTEL_COLLECTOR_NAME):4317,
              // which (being defined last) wins over the value below. We disabled
              // the bundled collector, and overriding default.env dropped the
              // chart's own OTEL_COLLECTOR_NAME definition, leaving that reference
              // unresolved so no spans were exported. Define it here (first, so
              // Kubernetes can substitute it into the later value) to point every
              // demo service at our ADOT collector's gRPC port.
              name: 'OTEL_COLLECTOR_NAME',
              value: 'adot-collector',
            },
            {
              name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
              value: 'http://adot-collector.otel-demo:4318',
            },
            {
              name: 'OTEL_RESOURCE_ATTRIBUTES',
              value: 'environment=olympus',
            },
          ],
        },
      },
    });
    otelDemoChart.node.addDependency(adotCollectorManifest);

    // =============================================================
    // Claude Code Simulator Deployment
    // =============================================================
    const claudeCodeImage = new DockerImageAsset(this, 'ClaudeCodeSimulatorImage', {
      directory: path.join(__dirname, '../workloads/claude-code-simulator'),
      platform: Platform.LINUX_AMD64,
    });

    const claudeCodeDeployment = cluster.addManifest('ClaudeCodeSimulatorDeployment',
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'claude-code-simulator',
          namespace: 'claude-code',
        },
        spec: {
          replicas: 1,
          selector: {
            matchLabels: { app: 'claude-code-simulator' },
          },
          template: {
            metadata: {
              labels: { app: 'claude-code-simulator' },
            },
            spec: {
              containers: [
                {
                  name: 'claude-code-simulator',
                  image: claudeCodeImage.imageUri,
                  env: [
                    {
                      name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
                      value: 'http://adot-collector.otel-demo:4318',
                    },
                  ],
                  resources: {
                    requests: {
                      cpu: '128m',
                      memory: '256Mi',
                    },
                    limits: {
                      memory: '512Mi',
                    },
                  },
                },
              ],
            },
          },
        },
      },
    );
    claudeCodeDeployment.node.addDependency(namespaces);

    // =============================================================
    // Strands Agent Deployment
    // =============================================================
    const strandsAgentImage = new DockerImageAsset(this, 'StrandsAgentImage', {
      directory: path.join(__dirname, '../workloads/strands-agent'),
      platform: Platform.LINUX_AMD64,
    });

    const strandsAgentDeployment = cluster.addManifest('StrandsAgentDeployment',
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'strands-agent',
          namespace: 'agent-observability',
        },
        spec: {
          replicas: 1,
          selector: {
            matchLabels: { app: 'strands-agent' },
          },
          template: {
            metadata: {
              labels: { app: 'strands-agent' },
            },
            spec: {
              containers: [
                {
                  name: 'strands-agent',
                  image: strandsAgentImage.imageUri,
                  env: [
                    {
                      name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
                      value: 'http://adot-collector.otel-demo:4318',
                    },
                    {
                      name: 'AWS_DEFAULT_REGION',
                      value: region,
                    },
                    {
                      // Claude Sonnet 4 (2025-05) is now Legacy/blocked; use the
                      // current active cross-region inference profile for Sonnet 4.5.
                      name: 'BEDROCK_MODEL_ID',
                      value: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    },
                  ],
                  resources: {
                    requests: {
                      cpu: '256m',
                      memory: '512Mi',
                    },
                    limits: {
                      memory: '1Gi',
                    },
                  },
                },
              ],
            },
          },
        },
      },
    );
    strandsAgentDeployment.node.addDependency(namespaces);

    // =============================================================
    // Go Prometheus App Deployment
    // =============================================================
    const promGoAppImage = new DockerImageAsset(this, 'PromGoAppImage', {
      directory: path.join(__dirname, '../workloads/prom-go-app'),
    });

    const promGoAppDeployment = cluster.addManifest('PromGoAppDeployment',
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'prom-go-app',
          namespace: 'prom-app-demo',
        },
        spec: {
          replicas: 2,
          selector: {
            matchLabels: { app: 'prom-go-app' },
          },
          template: {
            metadata: {
              labels: { app: 'prom-go-app' },
              annotations: {
                'prometheus.io/scrape': 'true',
                'prometheus.io/port': '8080',
                'prometheus.io/path': '/metrics',
              },
            },
            spec: {
              containers: [
                {
                  name: 'prom-go-app',
                  image: promGoAppImage.imageUri,
                  ports: [
                    { containerPort: 8080, name: 'http' },
                  ],
                  resources: {
                    requests: {
                      cpu: '64m',
                      memory: '64Mi',
                    },
                    limits: {
                      memory: '128Mi',
                    },
                  },
                },
              ],
            },
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: 'prom-go-app',
          namespace: 'prom-app-demo',
        },
        spec: {
          selector: { app: 'prom-go-app' },
          ports: [
            { name: 'http', port: 8080, targetPort: 8080 },
          ],
        },
      },
    );
    promGoAppDeployment.node.addDependency(namespaces);

    // =============================================================
    // Stack Outputs
    // =============================================================
    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'EKS Cluster Name',
    });

    new cdk.CfnOutput(this, 'KubectlConfigCommand', {
      value: `aws eks update-kubeconfig --name ${cluster.clusterName} --region ${this.region}`,
      description: 'Command to configure kubectl for this cluster',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: cluster.clusterEndpoint,
      description: 'EKS Cluster API endpoint',
    });

    new cdk.CfnOutput(this, 'CloudWatchAgentRoleArn', {
      value: nodeGroup.role.roleArn,
      description: 'IAM Role ARN for CloudWatch Agent (node group role)',
    });

    // =============================================================
    // Managed Prometheus Scraper for Go app
    // Scrapes Prometheus metrics from pods in prom-app-demo namespace
    // and sends them to CloudWatch via the default dataset
    // =============================================================
    // Simple scrape config validated to work with CloudWatch destination
    // Note: CloudWatch destination rejects configs with bearer_token_file or authorization fields
    const scrapeConfigBase64 = Buffer.from(
      'global:\n' +
      '  scrape_interval: 30s\n' +
      'scrape_configs:\n' +
      '  - job_name: pod_exporter\n' +
      '    kubernetes_sd_configs:\n' +
      '      - role: pod\n'
    ).toString('base64');

    const defaultDatasetArn = `arn:aws:cloudwatch:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:dataset/default`;

    // CloudFormation's AWS::APS::Scraper resource handler has a bug with CloudWatchConfiguration
    // destination validation. We use a Custom Resource Lambda to call the API directly instead.
    const scraperLambdaRole = new iam.Role(this, 'ScraperLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    scraperLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['aps:CreateScraper', 'aps:DeleteScraper', 'aps:DescribeScraper'],
      resources: ['*'],
    }));
    scraperLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups', 'ec2:CreateNetworkInterface',
                'ec2:DeleteNetworkInterface', 'ec2:DescribeNetworkInterfaces'],
      resources: ['*'],
    }));
    // APS CreateScraper (EKS source) auto-provisions an EKS access entry for the
    // scraper's service-linked role, so the calling Lambda must be allowed to manage
    // access entries on the cluster. Without these the API returns 403
    // "not authorized to perform: eks:CreateAccessEntry".
    scraperLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'eks:DescribeCluster',
        'eks:CreateAccessEntry',
        'eks:DeleteAccessEntry',
        'eks:DescribeAccessEntry',
        'eks:AssociateAccessPolicy',
        'eks:DisassociateAccessPolicy',
        'eks:ListAssociatedAccessPolicies',
      ],
      resources: [
        cluster.clusterArn,
        `arn:aws:eks:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:access-entry/${cluster.clusterName}/*`,
      ],
    }));
    scraperLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:CreateServiceLinkedRole'],
      resources: ['arn:aws:iam::*:role/aws-service-role/scraper.aps.amazonaws.com/*'],
    }));

    const scraperLambda = new cdk.aws_lambda.Function(this, 'ScraperFunction', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      role: scraperLambdaRole,
      timeout: cdk.Duration.minutes(5),
      code: cdk.aws_lambda.Code.fromInline(`
import json
import urllib3
import os
import hashlib
import hmac
import datetime

http = urllib3.PoolManager()

def handler(event, context):
    print(json.dumps(event))
    request_type = event['RequestType']
    props = event['ResourceProperties']

    try:
        if request_type == 'Create':
            region = os.environ['AWS_REGION']
            # Build the request body exactly as proven with awscurl
            import base64
            config_yaml = props['ConfigurationBlob']
            config_b64 = base64.b64encode(config_yaml.encode('utf-8')).decode('utf-8')

            body = json.dumps({
                'alias': props['Alias'],
                'source': {
                    'eksConfiguration': {
                        'clusterArn': props['ClusterArn'],
                        'securityGroupIds': props['SecurityGroupIds'],
                        'subnetIds': props['SubnetIds'],
                    }
                },
                'destination': {
                    'cloudWatchConfiguration': {
                        'datasetArn': props['DatasetArn'],
                    }
                },
                'scrapeConfiguration': {
                    'configurationBlob': config_b64,
                },
            })

            # Make SigV4-signed request to APS API
            endpoint = f'https://aps.{region}.amazonaws.com/scrapers'
            response = sigv4_request('POST', endpoint, body, region, 'aps')
            print(f"API response: {response.status} {response.data.decode()}")

            if response.status in (200, 201, 202):
                result = json.loads(response.data.decode())
                scraper_id = result.get('scraperId', 'unknown')
                send_response(event, context, 'SUCCESS', {'ScraperId': scraper_id}, scraper_id)
            else:
                send_response(event, context, 'FAILED', {}, 'NONE', f"API returned {response.status}: {response.data.decode()}")

        elif request_type == 'Delete':
            scraper_id = event.get('PhysicalResourceId', '')
            if scraper_id and scraper_id.startswith('s-'):
                region = os.environ['AWS_REGION']
                endpoint = f'https://aps.{region}.amazonaws.com/scrapers/{scraper_id}'
                try:
                    response = sigv4_request('DELETE', endpoint, '', region, 'aps')
                    print(f"Delete response: {response.status}")
                except Exception as e:
                    print(f"Delete error (non-fatal): {e}")
            send_response(event, context, 'SUCCESS', {}, scraper_id)
        else:
            send_response(event, context, 'SUCCESS', {}, event.get('PhysicalResourceId', ''))
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        send_response(event, context, 'FAILED', {}, event.get('PhysicalResourceId', 'NONE'), str(e))


def sigv4_request(method, url, body, region, service):
    """Make a SigV4-signed request using Lambda's execution role credentials."""
    import urllib.parse
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.session import Session

    session = Session()
    credentials = session.get_credentials().get_frozen_credentials()

    parsed = urllib.parse.urlparse(url)
    headers = {
        'Content-Type': 'application/json',
        'Host': parsed.hostname,
    }

    request = AWSRequest(method=method, url=url, data=body, headers=headers)
    SigV4Auth(credentials, service, region).add_auth(request)

    return http.request(
        method,
        url,
        body=body.encode('utf-8') if body else None,
        headers=dict(request.headers),
    )


def send_response(event, context, status, data, physical_id, reason=''):
    body = json.dumps({
        'Status': status,
        'Reason': reason or f'See CloudWatch Log Stream: {context.log_stream_name}',
        'PhysicalResourceId': physical_id,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data,
    })
    http.request('PUT', event['ResponseURL'], body=body, headers={'Content-Type': ''})
`),
    });

    // Raw Prometheus YAML (real newlines). The Lambda base64-encodes this before
    // calling the APS CreateScraper API. Using an array join avoids the previous bug
    // where '\\n' produced literal backslash-n characters instead of newlines, which
    // caused APS to reject the config with "Invalid Prometheus scrape configuration".
    const scrapeConfigYaml = [
      'global:',
      '  scrape_interval: 30s',
      'scrape_configs:',
      '  - job_name: pod_exporter',
      '    kubernetes_sd_configs:',
      '      - role: pod',
      '',
    ].join('\n');

    new cdk.CustomResource(this, 'ManagedScraper', {
      serviceToken: scraperLambda.functionArn,
      properties: {
        Alias: 'zeus-demo-prom-scraper',
        ClusterArn: cluster.clusterArn,
        SubnetIds: vpc.privateSubnets.map(s => s.subnetId),
        SecurityGroupIds: [cluster.clusterSecurityGroupId],
        DatasetArn: defaultDatasetArn,
        ConfigurationBlob: scrapeConfigYaml,
      },
    });

    // POST-DEPLOYMENT STEP: EKS Access Entry for Managed Scraper
    // The managed scraper auto-creates an IAM role (arn visible in scraper details
    // after creation). You must grant that role access to the EKS cluster:
    //
    //   aws eks create-access-entry \
    //     --cluster-name zeus-otel-demo \
    //     --principal-arn <SCRAPER_ROLE_ARN> \
    //     --type STANDARD
    //
    //   aws eks associate-access-policy \
    //     --cluster-name zeus-otel-demo \
    //     --principal-arn <SCRAPER_ROLE_ARN> \
    //     --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
    //     --access-scope type=cluster
    //
    // The scraper role ARN is only known after the CfnScraper is created.
    // You can retrieve it from the CloudFormation stack outputs or the
    // APS console under Scrapers > zeus-demo-prom-scraper > Role ARN.
  }
}
