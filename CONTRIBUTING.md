# Contributing to Claude Cluster

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/claudecluster.git`
3. Create a branch: `git checkout -b feature/your-feature`
4. Make your changes
5. Push and create a Pull Request

## Development Setup

```bash
npm install
npm run build
npm run test
```

## Code Style

- TypeScript with strict mode
- Use ESLint configuration provided
- Follow existing patterns in the codebase
- Add JSDoc comments for public APIs

## Testing

- Write tests for new features
- Ensure all tests pass before submitting PR
- Use TDD when possible (write test first)

```bash
npm run test        # Run tests
npm run test:watch  # Watch mode
```

## Commit Messages

Follow conventional commits:

```
type(scope): description

feat(scheduler): add GPU-aware task placement
fix(raft): handle split-brain recovery
docs(readme): update installation instructions
test(mcp): add tool integration tests
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`

## Pull Request Process

1. Update documentation if needed
2. Add tests for new functionality
3. Ensure CI passes
4. Request review from maintainers
5. Squash commits before merge

## Reporting Bugs

Use the [bug report template](https://github.com/dpaschal/claudecluster/issues/new?labels=bug) and include:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment (OS, Node version, etc.)
- Logs if applicable

## Requesting Features

Use the [feature request template](https://github.com/dpaschal/claudecluster/issues/new?labels=enhancement) and include:

- Use case description
- Proposed solution
- Alternatives considered

## Project Structure

```
claudecluster/
├── src/
│   ├── agent/       # Node agent (monitoring, execution)
│   ├── cluster/     # Raft, scheduling, membership
│   ├── discovery/   # Tailscale, node approval
│   ├── grpc/        # gRPC server/client
│   ├── kubernetes/  # K8s adapter
│   ├── mcp/         # MCP server and tools
│   └── security/    # Auth, secrets
├── proto/           # Protocol Buffer definitions
├── config/          # Configuration files
├── docs/            # Documentation
└── tests/           # Test files
```

## Questions?

- Open a [discussion](https://github.com/dpaschal/claudecluster/discussions)
- Check the [wiki](https://github.com/dpaschal/claudecluster/wiki)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
