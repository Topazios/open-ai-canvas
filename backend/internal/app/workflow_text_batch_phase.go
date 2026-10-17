package app

import (
	"errors"
	"fmt"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

var errWorkflowBatchUnscheduled = errors.New("workflow batch child not scheduled")

type workflowBatchWork struct {
	key, prompt, label string
	options            workflowBatchChildOptions
}

type workflowBatchPhase struct {
	results   []string
	completed int
	pending   int
	waiting   int
	failure   error
}

func (p workflowBatchPhase) complete() bool {
	return p.failure == nil && p.completed == len(p.results)
}

// Reconstruct the whole wave before admitting work: completion order must not
// change merge inputs, and an already failed sibling must stop new admission.
func (s *Service) runWorkflowBatchPhase(parent *model.Task, input map[string]any, work []workflowBatchWork) (workflowBatchPhase, error) {
	phase := workflowBatchPhase{results: make([]string, len(work))}
	policy, err := s.runtimeConcurrencySetting()
	if err != nil {
		return phase, err
	}
	missing := make([]int, 0, len(work))
	record := func(index int, result string, pending bool, err error) {
		if err != nil {
			if phase.failure == nil {
				phase.failure = fmt.Errorf("%s失败：%w", work[index].label, err)
			}
		} else if pending {
			phase.pending++
		} else {
			phase.results[index] = result
			phase.completed++
		}
	}
	for index, item := range work {
		options := item.options
		options.observeOnly = true
		result, pending, err := s.workflowBatchChild(parent, input, item.key, item.prompt, options)
		if errors.Is(err, errWorkflowBatchUnscheduled) {
			missing = append(missing, index)
			continue
		}
		record(index, result, pending, err)
	}
	phase.waiting = len(missing)
	for _, index := range missing {
		if phase.failure != nil || phase.pending >= policy.ConcurrencyFor(model.TaskConcurrencyText) {
			break
		}
		item := work[index]
		result, pending, err := s.workflowBatchChild(parent, input, item.key, item.prompt, item.options)
		if errors.Is(err, repository.ErrActiveTaskLimit) {
			break
		}
		phase.waiting--
		record(index, result, pending, err)
	}
	return phase, nil
}

func (s *Service) yieldWorkflowBatchPhase(parent *model.Task, stage string, phase workflowBatchPhase, progress int) error {
	if phase.failure != nil {
		if phase.pending == 0 {
			return s.failWorkflowTextBatch(parent, stage+"："+phase.failure.Error())
		}
		return s.deferWorkflowTextBatch(parent, fmt.Sprintf("%s · 部分批次失败，等待 %d 个已提交批次结束", stage, phase.pending), progress)
	}
	return s.deferWorkflowTextBatch(parent, fmt.Sprintf("%s · 已完成 %d/%d · 处理中或排队 %d · 待调度 %d", stage, phase.completed, len(phase.results), phase.pending, phase.waiting), progress)
}
