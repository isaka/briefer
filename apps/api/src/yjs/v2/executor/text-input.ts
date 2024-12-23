import {
  InputBlock,
  YBlock,
  getInputAttributes,
  updateInputValue,
  updateInputVariable,
  updateInputBlockExecutedAt,
  ExecutionQueueItem,
  ExecutionQueueItemTextInputSaveValueMetadata,
  ExecutionQueueItemTextInputRenameVariableMetadata,
} from '@briefer/editor'
import * as Y from 'yjs'
import { setVariable } from '../../../python/input.js'
import { logger } from '../../../logger.js'
import { WSSharedDocV2 } from '../index.js'

export type InputEffects = {
  setVariable: typeof setVariable
}

export interface ITextInputExecutor {
  saveValue(
    executionItem: ExecutionQueueItem,
    block: Y.XmlElement<InputBlock>,
    metadata: ExecutionQueueItemTextInputSaveValueMetadata
  ): Promise<void>
  renameVariable(
    executionItem: ExecutionQueueItem,
    block: Y.XmlElement<InputBlock>,
    metadata: ExecutionQueueItemTextInputRenameVariableMetadata
  ): Promise<void>
}

export class TextInputExecutor implements ITextInputExecutor {
  constructor(
    private readonly sessionId: string,
    private readonly workspaceId: string,
    private readonly documentId: string,
    private readonly blocks: Y.Map<YBlock>,
    private readonly effects: InputEffects = {
      setVariable,
    }
  ) {}

  public async renameVariable(
    executionItem: ExecutionQueueItem,
    block: Y.XmlElement<InputBlock>,
    _metadata: ExecutionQueueItemTextInputRenameVariableMetadata
  ) {
    try {
      const attrs = getInputAttributes(block, this.blocks)

      const { newValue: newVariableName } = attrs.variable
      const { value } = attrs.value

      const dfNameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/
      if (!dfNameRegex.test(newVariableName)) {
        updateInputVariable(block, this.blocks, {
          error: 'invalid-variable-name',
        })
        executionItem.setCompleted('error')
        return
      }

      logger().trace(
        {
          sessionId: this.sessionId,
          workspaceId: this.workspaceId,
          documentId: this.documentId,
          blockId: attrs.id,
          variableName: newVariableName,
        },
        'Saving input variable'
      )

      let aborted = false
      let cleanup = executionItem.observeStatus((status) => {
        if (status._tag === 'aborting') {
          aborted = true
        }
      })

      const { promise, abort } = await this.effects.setVariable(
        this.workspaceId,
        this.sessionId,
        newVariableName,
        value
      )

      if (aborted) {
        await abort()
      }

      let abortP = Promise.resolve(aborted)
      cleanup()
      cleanup = executionItem.observeStatus((status) => {
        if (status._tag === 'aborting') {
          abortP = abort().then(() => true)
        }
      })

      await promise
      aborted = await abortP
      cleanup()

      if (!aborted) {
        updateInputVariable(block, this.blocks, {
          value: newVariableName,
          error: null,
        })
        logger().trace(
          {
            sessionId: this.sessionId,
            workspaceId: this.workspaceId,
            documentId: this.documentId,
            blockId: attrs.id,
            variableName: newVariableName,
          },
          'Saved input variable'
        )
      }
      executionItem.setCompleted(aborted ? 'aborted' : 'success')
    } catch (err) {
      logger().error(
        {
          workspaceId: this.workspaceId,
          documentId: this.documentId,
          blockId: executionItem.getBlockId(),
          error: err,
        },
        'Failed to rename text input variable'
      )

      updateInputVariable(block, this.blocks, {
        error: 'unexpected-error',
      })
      executionItem.setCompleted('error')
    }
  }

  public async saveValue(
    executionItem: ExecutionQueueItem,
    block: Y.XmlElement<InputBlock>,
    _metadata: ExecutionQueueItemTextInputSaveValueMetadata
  ) {
    try {
      const attrs = getInputAttributes(block, this.blocks)
      const { value: variableName } = attrs.variable
      const { newValue } = attrs.value

      logger().trace(
        {
          sessionId: this.sessionId,
          workspaceId: this.workspaceId,
          documentId: this.documentId,
          blockId: block.getAttribute('id'),
          variableName,
        },
        'Saving input value'
      )

      await this.effects
        .setVariable(this.workspaceId, this.sessionId, variableName, newValue)
        .then(({ promise }) => promise)
      updateInputValue(block, {
        value: newValue,
        error: null,
      })
      updateInputBlockExecutedAt(block, new Date())
      logger().trace(
        {
          workspaceId: this.workspaceId,
          documentId: this.documentId,
          blockId: attrs.id,
          variableName,
        },
        'Saved input value'
      )
      executionItem.setCompleted('success')
    } catch (err) {
      logger().error(
        {
          sessionId: this.sessionId,
          workspaceId: this.workspaceId,
          documentId: this.documentId,
          blockId: executionItem.getBlockId(),
          error: err,
        },
        'Failed to save text input value'
      )

      updateInputValue(block, {
        error: 'unexpected-error',
      })
      executionItem.setCompleted('error')
    }
  }

  public static fromWSSharedDocV2(doc: WSSharedDocV2) {
    return new TextInputExecutor(
      doc.id,
      doc.workspaceId,
      doc.documentId,
      doc.blocks,
      {
        setVariable,
      }
    )
  }
}
