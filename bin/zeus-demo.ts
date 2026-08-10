#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ZeusDemoStack } from '../lib/zeus-demo-stack';

const app = new cdk.App();

// Zeus OTel + CloudWatch Demo Stack
// Deploys EKS cluster with CloudWatch Observability addon for OpenTelemetry integration
new ZeusDemoStack(app, 'ZeusDemoStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-2',
  },
  description: 'Zeus OTel + CloudWatch Observability Demo - EKS infrastructure with OpenTelemetry and CloudWatch integration',
});
