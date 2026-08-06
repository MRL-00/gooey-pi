import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ExtensionUiQuestion, ExtensionUiRequest } from '@/lib/extension-ui'
import { Modal } from './ui'

const OTHER_OPTION = 'Other (type your own answer)'

export type ExtensionUiResponse =
  | { cancelled: true }
  | { value: string }
  | { confirmed: boolean }
  | { values: Record<string, string> }

interface ExtensionUiModalProps {
  request: ExtensionUiRequest
  onRespond(response: ExtensionUiResponse): void
}

function questionnaireAnswer(
  question: ExtensionUiQuestion,
  selectedIndex: number,
  contexts: Record<string, string>,
  otherAnswers: Record<string, string>,
) {
  const selected = question.options[selectedIndex]
  const context = contexts[question.id]?.trim()
  if (selected === OTHER_OPTION) {
    const answer = otherAnswers[question.id]?.trim()
    if (!answer) return undefined
    return {
      answer,
      answerSource: 'freeform' as const,
      ...(context ? { context } : {}),
    }
  }
  return {
    answer: selected,
    answerSource: 'option' as const,
    ...(context ? { context } : {}),
  }
}

export function ExtensionUiModal({ request, onRespond }: ExtensionUiModalProps) {
  const prefill = request.method === 'editor' ? request.prefill : undefined
  const [value, setValue] = useState(prefill ?? '')
  const [selected, setSelected] = useState(0)
  const [questionIndex, setQuestionIndex] = useState(0)
  const [selectedByQuestion, setSelectedByQuestion] = useState<Record<string, number>>({})
  const [answeredByQuestion, setAnsweredByQuestion] = useState<Record<string, boolean>>({})
  const [contexts, setContexts] = useState<Record<string, string>>({})
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({})
  const otherInputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const questionnaireRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setValue(prefill ?? '')
    setSelected(0)
  }, [prefill, request.id, request.method])

  useEffect(() => {
    if (request.method !== 'questionnaire') return
    setQuestionIndex((current) => Math.min(current, request.questions.length))
    setSelectedByQuestion((current) => {
      const next = { ...current }
      for (const question of request.questions) if (next[question.id] === undefined) next[question.id] = 0
      return next
    })
  }, [request.method, request.id, request.method === 'questionnaire' ? request.questions.length : 0])

  useEffect(() => {
    if (request.method !== 'questionnaire') return
    setQuestionIndex(0)
    setSelectedByQuestion(Object.fromEntries(request.questions.map((question) => [question.id, 0])))
    setAnsweredByQuestion({})
    setContexts({})
    setOtherAnswers({})
  }, [request.id])

  useEffect(() => {
    if (request.method !== 'questionnaire' || !request.complete) return
    const container = questionnaireRef.current
    if (!container || container.contains(document.activeElement)) return
    const focusTarget = container.querySelector<HTMLElement>('.extension-question__options button, .extension-questionnaire__submit button')
    focusTarget?.focus()
  }, [request.id, request.method === 'questionnaire' ? request.complete : false, questionIndex])

  const cancel = () => onRespond({ cancelled: true })

  const questionnaire = request.method === 'questionnaire' ? request : undefined
  const activeQuestion = questionnaire && questionIndex < questionnaire.questions.length
    ? questionnaire.questions[questionIndex]
    : undefined
  const activeSelected = activeQuestion ? selectedByQuestion[activeQuestion.id] ?? 0 : 0
  const activeIsOther = activeQuestion?.options[activeSelected] === OTHER_OPTION
  const allAnswered = Boolean(questionnaire?.complete && questionnaire.questions.length > 0 && questionnaire.questions.every((question) => answeredByQuestion[question.id]))

  const selectQuestionOption = (index: number) => {
    if (!activeQuestion) return
    const bounded = Math.max(0, Math.min(activeQuestion.options.length - 1, index))
    setSelectedByQuestion((current) => ({ ...current, [activeQuestion.id]: bounded }))
    setAnsweredByQuestion((current) => ({ ...current, [activeQuestion.id]: false }))
  }

  const commitQuestion = (index = activeSelected) => {
    if (!activeQuestion) return
    const bounded = Math.max(0, Math.min(activeQuestion.options.length - 1, index))
    const answer = questionnaireAnswer(activeQuestion, bounded, contexts, otherAnswers)
    if (!answer) {
      otherInputRefs.current[activeQuestion.id]?.focus()
      return
    }
    setSelectedByQuestion((current) => ({ ...current, [activeQuestion.id]: bounded }))
    setAnsweredByQuestion((current) => ({ ...current, [activeQuestion.id]: true }))
    setQuestionIndex((current) => Math.min(current + 1, questionnaire?.questions.length ?? current + 1))
  }

  const submitQuestionnaire = () => {
    if (!questionnaire || !allAnswered) return
    const values: Record<string, string> = {}
    for (const question of questionnaire.questions) {
      const answer = questionnaireAnswer(question, selectedByQuestion[question.id] ?? 0, contexts, otherAnswers)
      if (!answer) return
      values[question.id] = JSON.stringify(answer)
    }
    onRespond({ values })
  }

  const handleQuestionnaireKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!questionnaire || !questionnaire.complete) return
    const isTextInput = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setQuestionIndex((current) => Math.max(0, current - 1))
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      setQuestionIndex((current) => Math.min(questionnaire.questions.length, current + 1))
      return
    }
    if (questionIndex === questionnaire.questions.length) {
      if (event.key === 'Enter') {
        event.preventDefault()
        submitQuestionnaire()
      }
      return
    }
    if (!activeQuestion) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const delta = event.key === 'ArrowUp' ? -1 : 1
      selectQuestionOption(activeSelected + delta)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      commitQuestion()
      return
    }
    // Let text fields receive printable characters, including digits. Number
    // shortcuts apply when the question itself has focus, while a clicked
    // context/Other field should behave like a normal text input.
    if (isTextInput && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1
      if (index < activeQuestion.options.length) {
        event.preventDefault()
        selectQuestionOption(index)
      }
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.target instanceof HTMLElement && event.target.tagName !== 'INPUT') {
      event.preventDefault()
      if (activeIsOther) {
        const current = otherAnswers[activeQuestion.id] ?? ''
        setOtherAnswers((values) => ({ ...values, [activeQuestion.id]: `${current}${event.key}` }))
        window.requestAnimationFrame(() => otherInputRefs.current[activeQuestion.id]?.focus())
      } else {
        const current = contexts[activeQuestion.id] ?? ''
        setContexts((values) => ({ ...values, [activeQuestion.id]: `${current}${event.key}` }))
      }
    }
  }

  return (
    <Modal title={request.title} onClose={cancel} footer={(
      <>
        <button type="button" className="button" onClick={cancel}>Cancel</button>
        {request.method === 'confirm' ? <button type="button" className="button button--primary" onClick={() => onRespond({ confirmed: true })}>Confirm</button> : null}
        {request.method === 'input' || request.method === 'editor' ? <button type="button" className="button button--primary" disabled={!value.trim()} onClick={() => onRespond({ value })}>Continue</button> : null}
        {request.method === 'questionnaire' ? <button type="button" className="button button--primary" disabled={!allAnswered} onClick={submitQuestionnaire}>Submit answers</button> : null}
      </>
    )}>
      {request.method === 'questionnaire' ? (
        <div ref={questionnaireRef} className="extension-questionnaire" onKeyDown={handleQuestionnaireKeyDown}>
          {!request.complete ? <p className="modal-intro">Preparing questions…</p> : null}
          {request.complete ? (
            <>
              <div className="extension-questionnaire__progress" aria-label="Question progress">
                {request.questions.map((question, index) => (
                  <button type="button" key={question.id} className={questionIndex === index ? 'is-active' : ''} onClick={() => setQuestionIndex(index)}>
                    {answeredByQuestion[question.id] ? '✓' : '○'} {index + 1}
                  </button>
                ))}
                <button type="button" className={questionIndex === request.questions.length ? 'is-active' : ''} onClick={() => setQuestionIndex(request.questions.length)}>✓ Submit</button>
              </div>
              {activeQuestion ? (
                <div className="extension-questionnaire__question">
                  <p className="modal-intro">Question {questionIndex + 1} of {request.questions.length}</p>
                  <h3>{activeQuestion.title}</h3>
                  <div className="extension-question__options" role="listbox" aria-label={activeQuestion.title}>
                    {activeQuestion.options.map((option, index) => {
                      const isSelected = activeSelected === index
                      const isOther = option === OTHER_OPTION
                      return isOther && isSelected ? (
                        <div className="extension-question__other-row is-selected" role="option" aria-selected="true" key={`${option}-${index}`}>
                          <button type="button" onClick={() => selectQuestionOption(index)}><span className="extension-question__option-index">{index + 1}</span><span>{option}</span></button>
                          <input
                            ref={(element) => { otherInputRefs.current[activeQuestion.id] = element }}
                            autoFocus
                            value={otherAnswers[activeQuestion.id] ?? ''}
                            placeholder="Type your answer"
                            aria-label="Other answer"
                            onChange={(event) => setOtherAnswers((values) => ({ ...values, [activeQuestion.id]: event.target.value }))}
                          />
                        </div>
                      ) : (
                        <button
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className={isSelected ? 'is-selected' : ''}
                          key={`${option}-${index}`}
                          onClick={() => selectQuestionOption(index)}
                        >
                          <span className="extension-question__option-index">{index + 1}</span>
                          <span>{option}</span>
                        </button>
                      )
                    })}
                  </div>
                  <label className="field extension-questionnaire__context">
                    <span>Type to add context</span>
                    <input
                      value={contexts[activeQuestion.id] ?? ''}
                      placeholder="Type to add context"
                      aria-label="Additional context"
                      onChange={(event) => setContexts((values) => ({ ...values, [activeQuestion.id]: event.target.value }))}
                    />
                  </label>
                  <p className="extension-questionnaire__hint">← → questions · ↑ ↓ choices · 1–9 select · Enter continue</p>
                </div>
              ) : (
                <div className="extension-questionnaire__submit" role="listbox" aria-label="Submit answers">
                  <button type="button" role="option" aria-selected="true" disabled={!allAnswered} onClick={submitQuestionnaire}>✓ Submit answers</button>
                  {request.questions.map((question) => {
                    const answer = questionnaireAnswer(question, selectedByQuestion[question.id] ?? 0, contexts, otherAnswers)
                    return <p key={question.id}><strong>{question.index + 1}.</strong> {answer?.answer ?? 'Not answered'}</p>
                  })}
                </div>
              )}
            </>
          ) : null}
        </div>
      ) : null}
      {request.method === 'select' ? (
        <div className="extension-question">
          <p className="modal-intro">Choose an option to let Prime continue.</p>
          <div className="extension-question__options" role="listbox" aria-label={request.title}>
            {request.options.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={selected === index}
                className={selected === index ? 'is-selected' : ''}
                key={`${option}-${index}`}
                onClick={() => { setSelected(index); onRespond({ value: option }) }}
                onFocus={() => setSelected(index)}
              >
                <span className="extension-question__option-index">{index + 1}</span>
                <span>{option}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {request.method === 'confirm' ? <p className="modal-intro extension-question__message">{request.message}</p> : null}
      {request.method === 'input' ? <label className="field extension-question__field"><span>Response</span><input autoFocus value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && value.trim()) { event.preventDefault(); onRespond({ value }) } }} /></label> : null}
      {request.method === 'editor' ? <label className="field extension-question__field"><span>Response</span><textarea autoFocus rows={7} value={value} onChange={(event) => setValue(event.target.value)} /></label> : null}
    </Modal>
  )
}
