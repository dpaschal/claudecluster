#!/usr/bin/env node
/**
 * Submit a task to the Claude Cluster and stream output
 * Usage: node scripts/submit-task.js [node] [command]
 * Example: node scripts/submit-task.js rog2 "echo hello && sleep 2 && echo done"
 */

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const PROTO_PATH = path.join(__dirname, '../proto/cluster.proto');

async function main() {
  const targetNode = process.argv[2] || '';
  const command = process.argv[3] || 'echo "Hello from Claude Cluster!" && hostname && date';

  console.log('🚀 Submitting task to Claude Cluster');
  console.log(`   Target: ${targetNode || 'any node'}`);
  console.log(`   Command: ${command}`);
  console.log('');

  const packageDef = await protoLoader.load(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDef).cortex;

  const client = new proto.ClusterService(
    'localhost:50051',
    grpc.credentials.createInsecure()
  );

  const taskId = `task-${Date.now()}`;
  const spec = {
    task_id: taskId,
    type: 'TASK_TYPE_SHELL',
    shell: { command },
  };

  if (targetNode) {
    spec.constraints = { allowed_nodes: [targetNode] };
  }

  // Submit task
  client.SubmitTask({ spec }, (err, response) => {
    if (err) {
      console.error('❌ Submit error:', err.message);
      process.exit(1);
    }

    if (!response.accepted) {
      console.error('❌ Task rejected:', response.rejection_reason);
      process.exit(1);
    }

    console.log('✅ Task accepted');
    console.log(`   Task ID: ${response.task_id}`);
    if (response.assigned_node) {
      console.log(`   Assigned to: ${response.assigned_node}`);
    }
    console.log('');
    console.log('📡 Streaming output...');
    console.log('─'.repeat(50));

    // Stream task output
    const stream = client.StreamTaskOutput({ task_id: response.task_id });

    stream.on('data', (output) => {
      if (output.data) {
        const text = Buffer.from(output.data).toString();
        if (output.type === 'OUTPUT_TYPE_STDOUT') {
          process.stdout.write(text);
        } else if (output.type === 'OUTPUT_TYPE_STDERR') {
          process.stderr.write(text);
        }
      }
    });

    stream.on('error', (err) => {
      if (err.code !== grpc.status.CANCELLED) {
        console.error('\n❌ Stream error:', err.message);
      }
    });

    stream.on('end', () => {
      console.log('─'.repeat(50));

      // Get final status
      setTimeout(() => {
        client.GetTaskStatus({ task_id: response.task_id }, (err, status) => {
          if (err) {
            console.log('⚠️  Could not get final status');
          } else if (status) {
            console.log(`\n✅ Task completed`);
            console.log(`   State: ${status.state}`);
            console.log(`   Exit code: ${status.exit_code}`);
            if (status.assigned_node) {
              console.log(`   Executed on: ${status.assigned_node}`);
            }
          }
          process.exit(0);
        });
      }, 500);
    });
  });
}

main().catch(console.error);
