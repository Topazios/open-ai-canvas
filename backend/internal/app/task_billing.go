package app

import (
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// taskBillingCoordinator 只负责任务生命周期中的计费状态迁移和核对策略。
//
// 兑换码、充值和管理员人工核对仍属于 finance service；这里收敛的是任务
// 从排队、上游调用到终态这一条链路，避免 worker、provider 和终态协调器
// 各自决定如何退款或进入待核对。
type taskBillingCoordinator struct {
	repo taskBillingRepository
}

type taskBillingRepository interface {
	MarkBillingRunning(orderID string) error
	SettleBillingOrder(orderID string, providerRequestID string) error
	RestoreRefundedBillingOrder(orderID string, providerRequestID string) error
	RefundBillingOrder(orderID string, errorText string) error
	MarkBillingUncertain(orderID string, errorText string) error
	BillingOrder(orderID string) (*model.BillingOrder, error)
	TaskHasSuccessfulBillableCall(taskID string, orderID string) (bool, error)
}

var (
	// errTaskBillingReview 表示订单状态已经不能由重试流程安全推断，必须先完成费用核对。
	errTaskBillingReview = &AppError{Status: 409, Code: 409, Reason: "task_billing_review_required",
		Message: "上一次调用的费用仍待核对，请先在任务中心核对上游结果和账单，再重试；已完成结果及草稿保留"}
)

func newTaskBillingCoordinator(repo taskBillingRepository) *taskBillingCoordinator {
	return &taskBillingCoordinator{repo: repo}
}

func (c *taskBillingCoordinator) MarkBillingRunning(orderID string) error {
	if orderID == "" {
		return nil
	}
	return c.repo.MarkBillingRunning(orderID)
}

func (c *taskBillingCoordinator) SettleBilling(orderID string, providerRequestID string) error {
	if orderID == "" {
		return nil
	}
	return c.repo.SettleBillingOrder(orderID, providerRequestID)
}

func (c *taskBillingCoordinator) RestoreRefundedBilling(orderID string, providerRequestID string) error {
	if orderID == "" {
		return nil
	}
	return c.repo.RestoreRefundedBillingOrder(orderID, providerRequestID)
}

func (c *taskBillingCoordinator) RefundBilling(orderID string, errorText string) error {
	if orderID == "" {
		return nil
	}
	return c.repo.RefundBillingOrder(orderID, truncateRunes(errorText, 1000))
}

func (c *taskBillingCoordinator) MarkBillingUncertain(orderID string, errorText string) error {
	if orderID == "" {
		return nil
	}
	return c.repo.MarkBillingUncertain(orderID, truncateRunes(errorText, 1000))
}

// CheckRetryEligibility 收敛失败/取消任务重试前的计费状态校验。
//
// 计费订单读取失败不能被当作“没有待核对订单”继续放行，否则重试可能重复扣费。
// 只有明确读到订单且订单不是 uncertain 时，才允许进入后续的重新计费流程。
func (c *taskBillingCoordinator) CheckRetryEligibility(orderID string) error {
	return c.checkRetryEligibility(orderID, false)
}

// Explicit retries may proceed without changing the old order when both its
// fixed sale price and configured cost are zero. A zero reserve alone is not
// proof: usage-based, unknown-cost and priced calls still require review.
func (c *taskBillingCoordinator) CheckManualRetryEligibility(orderID string) error {
	return c.checkRetryEligibility(orderID, true)
}

func (c *taskBillingCoordinator) checkRetryEligibility(orderID string, manual bool) error {
	if strings.TrimSpace(orderID) == "" {
		return nil
	}
	order, err := c.repo.BillingOrder(orderID)
	if err != nil {
		return fmt.Errorf("读取任务计费订单失败：%w", err)
	}
	if order == nil {
		return fmt.Errorf("任务计费订单不存在：%s", orderID)
	}
	if order.Status == model.BillingStatusUncertain {
		if manual && billingOrderHasNoFinancialExposure(order) {
			return nil
		}
		return errTaskBillingReview
	}
	return nil
}

func billingOrderHasNoFinancialExposure(order *model.BillingOrder) bool {
	return order.BillingMode == "fixed_request" && order.ChargeLimitSet && order.ChargeLimitMicrocredits == 0 &&
		order.CostBillingMode == "fixed_request" &&
		order.CostPricing.Configured && order.UnitPriceMicrocredits == 0 &&
		order.AmountMicrocredits == 0 && order.ReservedAmountMicrocredits == 0 && order.ActualAmountMicrocredits == 0 && order.RefundedAmountMicrocredits == 0 &&
		order.InputTokenPriceMicrocredits == 0 && order.OutputTokenPriceMicrocredits == 0 && order.CachedTokenPriceMicrocredits == 0 &&
		order.CostPricing.UnitPriceMicrocredits == 0 && order.CostPricing.InputTokenPriceMicrocredits == 0 &&
		order.CostPricing.OutputTokenPriceMicrocredits == 0 && order.CostPricing.CachedTokenPriceMicrocredits == 0
}

func (c *taskBillingCoordinator) BillingFailureRequiresReview(orderID string, taskID string, err error) bool {
	if orderID == "" {
		return false
	}
	if billingFailureUncertain(err) {
		return true
	}
	order, orderErr := c.repo.BillingOrder(orderID)
	if orderErr != nil || order == nil || order.Status == model.BillingStatusUncertain {
		return true
	}
	hasSuccessfulCall, logErr := c.repo.TaskHasSuccessfulBillableCall(taskID, orderID)
	return logErr != nil || hasSuccessfulCall
}

func billingFailureUncertain(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{"524", "timeout", "超时", "deadline exceeded", "context canceled", "connection reset", "unexpected eof", "broken pipe"} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}
