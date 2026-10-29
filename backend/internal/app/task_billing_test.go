package app

import (
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

type taskBillingRepositoryStub struct {
	runningCalls      []string
	settleCalls       []string
	restoreCalls      []string
	refundCalls       []string
	uncertainCalls    []string
	order             *model.BillingOrder
	orderErr          error
	hasSuccessfulCall bool
	callErr           error
}

func (r *taskBillingRepositoryStub) MarkBillingRunning(orderID string) error {
	r.runningCalls = append(r.runningCalls, orderID)
	return nil
}

func (r *taskBillingRepositoryStub) SettleBillingOrder(orderID string, providerRequestID string) error {
	r.settleCalls = append(r.settleCalls, orderID+":"+providerRequestID)
	return nil
}

func (r *taskBillingRepositoryStub) RestoreRefundedBillingOrder(orderID string, providerRequestID string) error {
	r.restoreCalls = append(r.restoreCalls, orderID+":"+providerRequestID)
	return nil
}

func (r *taskBillingRepositoryStub) RefundBillingOrder(orderID string, errorText string) error {
	r.refundCalls = append(r.refundCalls, orderID+":"+errorText)
	return nil
}

func (r *taskBillingRepositoryStub) MarkBillingUncertain(orderID string, errorText string) error {
	r.uncertainCalls = append(r.uncertainCalls, orderID+":"+errorText)
	return nil
}

func (r *taskBillingRepositoryStub) BillingOrder(string) (*model.BillingOrder, error) {
	return r.order, r.orderErr
}

func (r *taskBillingRepositoryStub) TaskHasSuccessfulBillableCall(string, string) (bool, error) {
	return r.hasSuccessfulCall, r.callErr
}

func TestTaskBillingCoordinatorEmptyOrderIsNoOp(t *testing.T) {
	repo := &taskBillingRepositoryStub{}
	billing := newTaskBillingCoordinator(repo)

	if err := billing.MarkBillingRunning(""); err != nil {
		t.Fatalf("MarkBillingRunning() error = %v", err)
	}
	if err := billing.SettleBilling("", "provider-1"); err != nil {
		t.Fatalf("SettleBilling() error = %v", err)
	}
	if err := billing.RestoreRefundedBilling("", "provider-1"); err != nil {
		t.Fatalf("RestoreRefundedBilling() error = %v", err)
	}
	if err := billing.RefundBilling("", "refund"); err != nil {
		t.Fatalf("RefundBilling() error = %v", err)
	}
	if err := billing.MarkBillingUncertain("", "uncertain"); err != nil {
		t.Fatalf("MarkBillingUncertain() error = %v", err)
	}
	if billing.BillingFailureRequiresReview("", "task-1", errors.New("timeout")) {
		t.Fatal("BillingFailureRequiresReview() = true for empty order")
	}
	if len(repo.runningCalls)+len(repo.settleCalls)+len(repo.restoreCalls)+len(repo.refundCalls)+len(repo.uncertainCalls) != 0 {
		t.Fatalf("empty order should not reach repository: %#v", repo)
	}
}

func TestTaskBillingCoordinatorRetryEligibility(t *testing.T) {
	tests := []struct {
		name       string
		orderID    string
		order      *model.BillingOrder
		orderErr   error
		wantErr    bool
		wantReview bool
	}{
		{name: "empty order", wantErr: false},
		{name: "running order", orderID: "order-1", order: &model.BillingOrder{Status: model.BillingStatusRunning}, wantErr: false},
		{name: "settled order", orderID: "order-1", order: &model.BillingOrder{Status: model.BillingStatusSettled}, wantErr: false},
		{name: "refunded order", orderID: "order-1", order: &model.BillingOrder{Status: model.BillingStatusRefunded}, wantErr: false},
		{name: "uncertain order", orderID: "order-1", order: &model.BillingOrder{Status: model.BillingStatusUncertain}, wantErr: true, wantReview: true},
		{name: "missing order", orderID: "order-1", wantErr: true, wantReview: false},
		{name: "lookup failure", orderID: "order-1", orderErr: errors.New("database unavailable"), wantErr: true, wantReview: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			billing := newTaskBillingCoordinator(&taskBillingRepositoryStub{order: tt.order, orderErr: tt.orderErr})
			err := billing.CheckRetryEligibility(tt.orderID)
			if (err != nil) != tt.wantErr {
				t.Fatalf("CheckRetryEligibility() error = %v, wantErr %v", err, tt.wantErr)
			}
			if errors.Is(err, errTaskBillingReview) != tt.wantReview {
				t.Fatalf("CheckRetryEligibility() review = %v, wantReview %v, err = %v", errors.Is(err, errTaskBillingReview), tt.wantReview, err)
			}
		})
	}
}

func TestTaskBillingCoordinatorManualRetryAllowsOnlyConfiguredZeroExposure(t *testing.T) {
	freeOrder := &model.BillingOrder{
		ID: "free", Status: model.BillingStatusUncertain, BillingMode: "fixed_request", ChargeLimitSet: true,
		BillingCostSnapshot: model.BillingCostSnapshot{
			CostBillingMode: "fixed_request", CostPricing: model.CreditCostPricing{Configured: true},
		},
	}
	t.Run("manual retry permits confirmed zero exposure without mutating old order", func(t *testing.T) {
		repo := &taskBillingRepositoryStub{order: freeOrder}
		billing := newTaskBillingCoordinator(repo)
		if err := billing.CheckManualRetryEligibility("free"); err != nil {
			t.Fatalf("CheckManualRetryEligibility() error = %v", err)
		}
		if freeOrder.Status != model.BillingStatusUncertain {
			t.Fatalf("retry eligibility mutated the old order: %s", freeOrder.Status)
		}
		if err := billing.CheckRetryEligibility("free"); !errors.Is(err, errTaskBillingReview) {
			t.Fatalf("automatic retry should keep the billing review guard: %v", err)
		}
	})

	for _, tc := range []struct {
		name  string
		order model.BillingOrder
	}{
		{name: "positive sale price", order: model.BillingOrder{BillingMode: "fixed_request", ChargeLimitSet: true, UnitPriceMicrocredits: 1, BillingCostSnapshot: freeOrder.BillingCostSnapshot}},
		{name: "positive reserved amount", order: model.BillingOrder{BillingMode: "fixed_request", ChargeLimitSet: true, ReservedAmountMicrocredits: 1, BillingCostSnapshot: freeOrder.BillingCostSnapshot}},
		{name: "unknown cost", order: model.BillingOrder{BillingMode: "fixed_request"}},
		{name: "usage based cost", order: model.BillingOrder{BillingMode: "fixed_request", ChargeLimitSet: true, BillingCostSnapshot: model.BillingCostSnapshot{CostBillingMode: "token", CostPricing: model.CreditCostPricing{Configured: true}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.order.ID, tc.order.Status = "review", model.BillingStatusUncertain
			err := newTaskBillingCoordinator(&taskBillingRepositoryStub{order: &tc.order}).CheckManualRetryEligibility("review")
			if !errors.Is(err, errTaskBillingReview) {
				t.Fatalf("manual retry should require review: %v", err)
			}
			var appErr *AppError
			if !errors.As(err, &appErr) || appErr.Status != 409 || appErr.Reason != "task_billing_review_required" {
				t.Fatalf("billing review error lost its actionable conflict contract: %#v", appErr)
			}
		})
	}
}

func TestTaskBillingCoordinatorTruncatesFailureText(t *testing.T) {
	repo := &taskBillingRepositoryStub{}
	billing := newTaskBillingCoordinator(repo)
	reason := strings.Repeat("中", 1001)

	if err := billing.RefundBilling("order-1", reason); err != nil {
		t.Fatalf("RefundBilling() error = %v", err)
	}
	if err := billing.MarkBillingUncertain("order-1", reason); err != nil {
		t.Fatalf("MarkBillingUncertain() error = %v", err)
	}
	if got := repo.refundCalls[0]; !strings.HasSuffix(got, strings.Repeat("中", 1000)+"...") {
		t.Fatalf("refund reason was not truncated with compatibility suffix: %q", got)
	}
	if got := repo.uncertainCalls[0]; !strings.HasSuffix(got, strings.Repeat("中", 1000)+"...") {
		t.Fatalf("uncertain reason was not truncated with compatibility suffix: %q", got)
	}
}

func TestTaskBillingCoordinatorFailureReviewPolicy(t *testing.T) {
	tests := []struct {
		name string
		stub taskBillingRepositoryStub
		err  error
		want bool
	}{
		{name: "uncertain transport error", stub: taskBillingRepositoryStub{order: &model.BillingOrder{Status: model.BillingStatusSettled}}, err: errors.New("upstream timeout"), want: true},
		{name: "order lookup error", stub: taskBillingRepositoryStub{orderErr: errors.New("database unavailable")}, err: errors.New("provider unavailable"), want: true},
		{name: "uncertain order", stub: taskBillingRepositoryStub{order: &model.BillingOrder{Status: model.BillingStatusUncertain}}, err: errors.New("provider rejected"), want: true},
		{name: "successful billable call", stub: taskBillingRepositoryStub{order: &model.BillingOrder{Status: model.BillingStatusRunning}, hasSuccessfulCall: true}, err: errors.New("provider rejected"), want: true},
		{name: "normal failed call", stub: taskBillingRepositoryStub{order: &model.BillingOrder{Status: model.BillingStatusRunning}}, err: errors.New("provider rejected"), want: false},
		{name: "billable call lookup error", stub: taskBillingRepositoryStub{order: &model.BillingOrder{Status: model.BillingStatusRunning}, callErr: errors.New("database unavailable")}, err: errors.New("provider rejected"), want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			billing := newTaskBillingCoordinator(&tt.stub)
			if got := billing.BillingFailureRequiresReview("order-1", "task-1", tt.err); got != tt.want {
				t.Fatalf("BillingFailureRequiresReview() = %v, want %v", got, tt.want)
			}
		})
	}
}
