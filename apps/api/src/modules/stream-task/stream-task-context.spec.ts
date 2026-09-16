import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  MembershipTier,
  MessageRole,
  MessageStatus,
  Prisma,
  StreamTaskStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentAccessService } from '../agent-access/agent-access.service';
import { McDonaldsCredentialService } from '../mcdonalds-credential/mcdonalds-credential.service';
import { FlowTaskDispatcherService } from './flow-task-dispatcher.service';
import { StreamTaskService } from './stream-task.service';

describe('创建任务时冻结会话范围', () => {
  it('只捕获已完成历史，追加本轮用户消息，并在派发前落库', async () => {
    const rows = [
      { id: 'old-user', status: MessageStatus.DONE },
      { id: 'old-answer', status: MessageStatus.DONE },
      { id: 'unfinished', status: MessageStatus.STREAMING },
      { id: 'failed', status: MessageStatus.ERROR },
    ];
    const transaction = {
      conversation: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'conversation', isTest: false }),
      },
      agent: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'agent',
          enabled: true,
          minimumMembershipTier: MembershipTier.FREE,
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          membershipTier: MembershipTier.FREE,
          membershipExpiresAt: null,
        }),
      },
      message: {
        findMany: jest.fn((args: Prisma.MessageFindManyArgs) =>
          Promise.resolve(
            rows
              .filter((row) => row.status === args.where?.status)
              .map(({ id }) => ({ id })),
          ),
        ),
        create: jest.fn((args: Prisma.MessageCreateArgs) => {
          const id =
            args.data.role === MessageRole.USER
              ? 'current-user'
              : 'current-answer';
          rows.push({
            id,
            status:
              args.data.role === MessageRole.USER
                ? MessageStatus.DONE
                : MessageStatus.STREAMING,
          });
          return Promise.resolve({ id });
        }),
        count: jest.fn().mockResolvedValue(2),
      },
      streamTask: {
        create: jest.fn((args: Prisma.StreamTaskCreateArgs) =>
          Promise.resolve({
            ...args.data,
            id: 'task',
            status: StreamTaskStatus.PENDING,
          }),
        ),
        update: jest.fn(),
      },
      streamTaskRun: { create: jest.fn().mockResolvedValue({ id: 'run' }) },
    };
    const dispatcher = {
      resolveTaskFlowSnapshot: jest.fn().mockResolvedValue({
        agentId: 'agent',
        flowVersionId: 'flow-version',
        flowDigest: 'digest',
      }),
      dispatch: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        StreamTaskService,
        AgentAccessService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ STREAM_TASK_BUFFER_TTL: 300 }),
        },
        {
          provide: PrismaService,
          useValue: {
            $transaction: (run: (tx: typeof transaction) => Promise<unknown>) =>
              run(transaction),
          },
        },
        {
          provide: McDonaldsCredentialService,
          useValue: {
            getActiveCredentialId: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: FlowTaskDispatcherService, useValue: dispatcher },
      ],
    })
      .useMocker(() => ({}))
      .compile();

    await module
      .get(StreamTaskService)
      .createChatTask('conversation', '继续写第二章', 'user');

    expect(
      transaction.streamTask.create.mock.calls[0][0].data.contextMessageIds,
    ).toEqual(['old-user', 'old-answer', 'current-user']);
    expect(
      transaction.message.findMany.mock.invocationCallOrder[0],
    ).toBeLessThan(transaction.message.create.mock.invocationCallOrder[0]);
    expect(
      transaction.streamTask.create.mock.invocationCallOrder[0],
    ).toBeLessThan(dispatcher.dispatch.mock.invocationCallOrder[0]);
  });
});
